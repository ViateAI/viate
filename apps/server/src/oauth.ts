import { sameOrigin } from "./admin.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadOidcSigner, type IdTokenClaims } from "./oidc.js";
import { LoginRateLimiter } from "./rate-limit.js";
import { SessionStore, cookieHeader, parseCookies } from "./sessions.js";
import type { AdminStore, ExchangedAuthorizationCode } from "./store.js";

export const SERVICE_SCOPES = ["users:read", "channels:read", "keys:write", "usage:read"] as const;

const SERVICE_SCOPE_SET = new Set<string>(SERVICE_SCOPES);
const USER_SCOPES = ["openid", "email", "profile"] as const;
const USER_SCOPE_SET = new Set<string>(USER_SCOPES);
const OAUTH_COOKIE = "viate_oauth";
const OAUTH_MAX_AGE = 12 * 60 * 60;
const USER_SCOPE = "profile";
const ID_TOKEN_TTL_SECONDS = 10 * 60;
const NONCE_MAX_LENGTH = 512;
const OIDC_CLAIMS = [
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "auth_time",
  "nonce",
  "email",
  "email_verified",
  "name",
  "status",
] as const;

export type OAuthRouteOptions = {
  store: AdminStore;
  sessions?: SessionStore;
  publicUrl?: string | null;
  loginLimiter?: LoginRateLimiter;
};

export function safeAuthorizeReturn(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || !value.startsWith("/oauth/authorize?")) {
    return "/portal";
  }
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    return "/portal";
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/portal";
  }
  if (!decoded.startsWith("/oauth/authorize?") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) {
    return "/portal";
  }
  return value;
}

export function redirectUriAllowed(uri: string, allowHttp: boolean): boolean {
  if (uri.includes("#") || uri.includes("\\") || /\s/.test(uri)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password || url.origin === "null") {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol !== "http:") {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  return allowHttp;
}

export function parseRedirectUris(value: unknown, allowHttp: boolean): string[] {
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("redirectUris must be an array"), { statusCode: 400 });
  }
  const uris: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item !== item.trim() || !redirectUriAllowed(item, allowHttp)) {
      throw Object.assign(new Error("redirect URI is not allowed"), { statusCode: 400 });
    }
    if (uris.includes(item)) {
      throw Object.assign(new Error("redirect URI is duplicated"), { statusCode: 400 });
    }
    uris.push(item);
  }
  return uris;
}

export function parseServiceScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("scopes must be an array"), { statusCode: 400 });
  }
  const scopes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !SERVICE_SCOPE_SET.has(item) || scopes.includes(item)) {
      throw Object.assign(new Error("scope is not allowed"), { statusCode: 400 });
    }
    scopes.push(item);
  }
  return scopes;
}

export async function registerOAuthRoutes(app: FastifyInstance, options: OAuthRouteOptions): Promise<void> {
  const sessions = options.sessions ?? new SessionStore();
  const limiter = options.loginLimiter ?? new LoginRateLimiter();
  const publicUrl = normalizePublicUrl(options.publicUrl);
  const oidc = await loadOidcSigner(options.store.dataDir);

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    const record: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(text)) {
      record[key] = value;
    }
    done(null, record);
  });

  app.get("/.well-known/oauth-authorization-server", async (request) => {
    const issuer = issuerFor(request, publicUrl);
    return {
      ...authorizationServerMetadata(issuer),
      scopes_supported: [USER_SCOPE, ...SERVICE_SCOPES],
    };
  });

  app.get("/.well-known/openid-configuration", async (request) => {
    const issuer = issuerFor(request, publicUrl);
    return {
      ...authorizationServerMetadata(issuer),
      jwks_uri: `${issuer}/oauth/jwks`,
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
      claims_supported: [...OIDC_CLAIMS],
      scopes_supported: [...USER_SCOPES, ...SERVICE_SCOPES],
    };
  });

  app.get("/oauth/jwks", async () => oidc.jwks());

  app.get("/oauth/client-info", async (request, reply) => {
    const clientId = queryString(request.query, "client_id");
    const client = clientId ? options.store.getOAuthClient(clientId) : null;
    if (!client) {
      return reply.code(404).send({ error: { message: "oauth client not found", type: "viate_error" } });
    }
    return { name: client.name };
  });

  app.get("/oauth/authorize", async (request, reply) => {
    const clientId = queryString(request.query, "client_id");
    const redirectUri = queryString(request.query, "redirect_uri");
    const client = clientId ? options.store.getOAuthClient(clientId) : null;
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri) || !redirectUriAllowed(redirectUri, client.allowHttpRedirects)) {
      return authorizationPage(reply, 400, "authorization request is invalid");
    }
    if (!client.firstParty) {
      return authorizationPage(reply, 400, "consent not supported");
    }
    const responseType = queryString(request.query, "response_type");
    const challenge = queryString(request.query, "code_challenge");
    const method = queryString(request.query, "code_challenge_method");
    const requestedScope = readQuery(request.query, "scope");
    const requestedNonce = readQuery(request.query, "nonce");
    const state = queryString(request.query, "state");
    if (responseType !== "code") {
      return redirectError(reply, redirectUri, responseType ? "unsupported_response_type" : "invalid_request", "response_type must be code", state);
    }
    if (!challenge || method !== "S256") {
      return redirectError(reply, redirectUri, "invalid_request", "code_challenge S256 is required", state);
    }
    if (!requestedScope.ok) {
      return redirectError(reply, redirectUri, "invalid_scope", "scope is not allowed", state);
    }
    const grantedScope = grantedUserScope(requestedScope.value);
    if (!grantedScope.ok) {
      return redirectError(reply, redirectUri, "invalid_scope", "scope is not allowed", state);
    }
    if (!requestedNonce.ok) {
      return redirectError(reply, redirectUri, "invalid_request", "nonce is invalid", state);
    }
    const nonce = acceptedNonce(requestedNonce.value);
    if (!nonce.ok) {
      return redirectError(reply, redirectUri, "invalid_request", "nonce is invalid", state);
    }
    const cookies = parseCookies(request.headers.cookie);
    const session = sessions.get(cookies[OAUTH_COOKIE]);
    const user = session?.subject ? options.store.getUser(session.subject) : null;
    if (!session || !user || user.status !== "active") {
      const current = request.url.startsWith("/oauth/authorize?") ? request.url : "/oauth/authorize";
      return reply
        .code(302)
        .header("cache-control", "no-store")
        .header("location", `/portal/oauth-login?return=${encodeURIComponent(current)}`)
        .send();
    }
    const code = options.store.createAuthorizationCode({
      clientId: client.id,
      userId: user.id,
      redirectUri,
      codeChallenge: challenge,
      scope: grantedScope.scope,
      nonce: nonce.nonce,
      authTime: Math.floor(session.createdAt / 1000),
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) {
      target.searchParams.set("state", state);
    }
    return reply.code(302).header("cache-control", "no-store").header("location", target.toString()).send();
  });

  app.post("/oauth/login", async (request, reply) => {
    if (!sameOrigin(request)) {
      return reply.code(403).send({ error: { message: "invalid origin", type: "viate_error" } });
    }
    const body = asRecord(request.body);
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const key = `${request.ip || "unknown"}\n${email.trim().toLowerCase()}`;
    const limited = limiter.consume(key);
    if (!limited.allowed) {
      reply.header("retry-after", String(limited.retryAfterSeconds));
      return reply.code(429).send({ error: { message: "too many login attempts", type: "viate_error" } });
    }
    try {
      const user = options.store.authenticateUser(email, password);
      limiter.reset(key);
      const session = sessions.create(user.id);
      const secure = requestProto(request) === "https";
      reply.header(
        "set-cookie",
        cookieHeader(OAUTH_COOKIE, session.id, OAUTH_MAX_AGE, { path: "/oauth", sameSite: "Lax", secure }),
      );
      const requested = queryString(request.query, "return") ?? (typeof body.return === "string" ? body.return : undefined);
      return { ok: true, redirect: safeAuthorizeReturn(requested) };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/oauth/token", async (request, reply) => {
    const body = asRecord(request.body);
    const presented = presentedClient(request, body);
    if (presented === "malformed") {
      return oauthError(reply, 401, "invalid_client", "client authentication failed", true);
    }
    const client = presented ? options.store.verifyOAuthClient(presented.id, presented.secret) : null;
    if (!client) {
      return oauthError(reply, 401, "invalid_client", "client authentication failed", true);
    }
    const grantType = typeof body.grant_type === "string" ? body.grant_type : "";
    if (grantType === "authorization_code") {
      const code = typeof body.code === "string" ? body.code : "";
      const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
      const codeVerifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
      if (!code || !redirectUri || !codeVerifier) {
        return oauthError(reply, 400, "invalid_request", "code, redirect_uri, and code_verifier are required");
      }
      const exchanged = options.store.exchangeAuthorizationCode({
        clientId: client.id,
        code,
        redirectUri,
        codeVerifier,
      });
      if (!exchanged.ok) {
        return oauthError(reply, 400, exchanged.error, exchanged.description);
      }
      const idToken = scopeSet(exchanged.scope).has("openid")
        ? oidc.sign(idTokenClaims(issuerFor(request, publicUrl), exchanged))
        : undefined;
      return oauthTokens(reply, exchanged.grant, idToken);
    }
    if (grantType === "refresh_token") {
      const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
      if (!refreshToken) {
        return oauthError(reply, 400, "invalid_request", "refresh_token is required");
      }
      const rotated = options.store.rotateRefreshToken({ clientId: client.id, refreshToken });
      if (!rotated.ok) {
        return oauthError(reply, 400, rotated.error, rotated.description);
      }
      return oauthTokens(reply, rotated.grant);
    }
    if (grantType === "client_credentials") {
      const resolved = clientCredentialScope(client.scopes, body.scope);
      if (!resolved.ok) {
        return oauthError(reply, 400, "invalid_scope", "scope is not allowed");
      }
      const grant = options.store.issueClientCredentials(client.id, resolved.scope);
      return oauthTokens(reply, grant);
    }
    return oauthError(reply, 400, "unsupported_grant_type", "grant_type is not supported");
  });

  app.get("/oauth/userinfo", async (request, reply) => {
    const token = bearerToken(request);
    const access = token ? options.store.readUserAccessToken(token) : { status: "invalid" as const };
    if (access.status === "inactive") {
      reply.header("cache-control", "no-store");
      return reply.code(403).send({ error: "user_inactive", error_description: "user inactive" });
    }
    if (access.status !== "ok") {
      reply.header("cache-control", "no-store");
      return reply.code(401).send({ error: "invalid_token", error_description: "access token is invalid" });
    }
    reply.header("cache-control", "no-store");
    return userInfoClaims(access);
  });

  app.post("/oauth/revoke", async (request, reply) => {
    const body = asRecord(request.body);
    const presented = presentedClient(request, body);
    if (presented === "malformed" || !presented || !options.store.verifyOAuthClient(presented.id, presented.secret)) {
      return oauthError(reply, 401, "invalid_client", "client authentication failed", true);
    }
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) {
      return oauthError(reply, 400, "invalid_request", "token is required");
    }
    options.store.revokePresentedToken(presented.id, token);
    reply.header("cache-control", "no-store");
    return reply.code(200).send({});
  });
}

export function registerOAuthClientRoutes(app: FastifyInstance, store: AdminStore): void {
  app.get("/api/admin/oauth-clients", async () => {
    return { clients: store.listOAuthClients() };
  });

  app.post("/api/admin/oauth-clients", async (request, reply) => {
    const body = asRecord(request.body);
    try {
      const name = requiredName(body.name);
      const allowHttp = optionalBoolean(body, "allowHttpRedirects", "allow_http_redirects") ?? false;
      const redirectUris = parseRedirectUris(field(body, "redirectUris", "redirect_uris") ?? [], allowHttp);
      const scopes = parseServiceScopes(body.scopes ?? []);
      return store.createOAuthClient({ name, redirectUris, scopes, allowHttpRedirects: allowHttp });
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.patch("/api/admin/oauth-clients/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    try {
      const current = store.getOAuthClient(id);
      if (!current) {
        return reply.code(404).send({ error: { message: "oauth client not found", type: "viate_error" } });
      }
      const name = body.name === undefined ? undefined : requiredName(body.name);
      const allowHttp = optionalBoolean(body, "allowHttpRedirects", "allow_http_redirects");
      const nextAllow = allowHttp ?? current.allowHttpRedirects;
      const redirectField = field(body, "redirectUris", "redirect_uris");
      const redirectUris = redirectField === undefined ? current.redirectUris : parseRedirectUris(redirectField, nextAllow);
      if (redirectField === undefined) {
        for (const uri of redirectUris) {
          if (!redirectUriAllowed(uri, nextAllow)) {
            throw Object.assign(new Error("redirect URI is not allowed"), { statusCode: 400 });
          }
        }
      }
      const scopes = body.scopes === undefined ? undefined : parseServiceScopes(body.scopes);
      const client = store.updateOAuthClient(id, {
        ...(name === undefined ? {} : { name }),
        ...(redirectField === undefined ? {} : { redirectUris }),
        ...(scopes === undefined ? {} : { scopes }),
        ...(allowHttp === undefined ? {} : { allowHttpRedirects: allowHttp }),
      });
      return { client };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/api/admin/oauth-clients/:id/rotate-secret", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return store.rotateOAuthClientSecret(id);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.delete("/api/admin/oauth-clients/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      store.deleteOAuthClient(id);
      return { ok: true };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });
}

function clientCredentialScope(
  registered: string[],
  requested: unknown,
): { ok: true; scope: string } | { ok: false } {
  if (requested === undefined || requested === "") {
    return { ok: true, scope: registered.join(" ") };
  }
  if (typeof requested !== "string") {
    return { ok: false };
  }
  const parts = requested.split(" ").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return { ok: false };
  }
  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part) || !registered.includes(part)) {
      return { ok: false };
    }
    seen.add(part);
  }
  return { ok: true, scope: parts.join(" ") };
}

function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  };
}

function oauthTokens(
  reply: FastifyReply,
  grant: { accessToken: string; refreshToken?: string; expiresIn: number; scope: string },
  idToken?: string,
) {
  reply.header("cache-control", "no-store");
  return reply.code(200).send({
    access_token: grant.accessToken,
    token_type: "Bearer",
    expires_in: grant.expiresIn,
    ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
    ...(idToken ? { id_token: idToken } : {}),
    scope: grant.scope,
  });
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string, authenticate = false) {
  reply.header("cache-control", "no-store");
  if (authenticate) {
    reply.header("www-authenticate", 'Basic realm="oauth"');
  }
  return reply.code(status).send({ error, error_description: description });
}

function authorizationPage(reply: FastifyReply, status: number, message: string) {
  const text = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head><body><p>${text}</p></body></html>`);
}

function redirectError(reply: FastifyReply, redirectUri: string, error: string, description: string, state: string | undefined) {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state) {
    target.searchParams.set("state", state);
  }
  return reply.code(302).header("cache-control", "no-store").header("location", target.toString()).send();
}

function presentedClient(
  request: FastifyRequest,
  body: Record<string, unknown>,
): { id: string; secret: string } | "malformed" | null {
  const header = headerValue(request.headers.authorization);
  let basic: { id: string; secret: string } | null = null;
  if (header) {
    if (!header.startsWith("Basic ")) {
      return "malformed";
    }
    try {
      const decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) {
        return "malformed";
      }
      basic = {
        id: decodeURIComponent(decoded.slice(0, colon)),
        secret: decodeURIComponent(decoded.slice(colon + 1)),
      };
    } catch {
      return "malformed";
    }
  }
  const bodyId = typeof body.client_id === "string" ? body.client_id : undefined;
  const bodySecret = typeof body.client_secret === "string" ? body.client_secret : undefined;
  if ((bodyId === undefined) !== (bodySecret === undefined)) {
    return "malformed";
  }
  if (basic && bodyId !== undefined && (bodyId !== basic.id || bodySecret !== basic.secret)) {
    return "malformed";
  }
  if (basic) {
    return basic.id && basic.secret ? basic : "malformed";
  }
  if (bodyId !== undefined && bodySecret !== undefined) {
    return bodyId && bodySecret ? { id: bodyId, secret: bodySecret } : "malformed";
  }
  return null;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = headerValue(request.headers.authorization);
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token && !token.includes(" ") ? token : null;
}

function requestProto(request: FastifyRequest): string {
  return headerValue(request.headers["x-forwarded-proto"]) ?? (request.protocol || "http");
}

function issuerFor(request: FastifyRequest, publicUrl: string | null): string {
  if (publicUrl) {
    return publicUrl;
  }
  const host = headerValue(request.headers.host);
  const proto = requestProto(request);
  return host ? `${proto}://${host}` : `${proto}://localhost`;
}

function normalizePublicUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function grantedUserScope(scope: string | undefined): { ok: true; scope: string } | { ok: false } {
  if (scope === undefined || scope === "") {
    return { ok: true, scope: USER_SCOPE };
  }
  if (scope !== scope.trim()) {
    return { ok: false };
  }
  const parts = scope.split(" ");
  const seen = new Set<string>();
  for (const part of parts) {
    if (!part || seen.has(part) || !USER_SCOPE_SET.has(part)) {
      return { ok: false };
    }
    seen.add(part);
  }
  return { ok: true, scope: parts.join(" ") };
}

function acceptedNonce(value: string | undefined): { ok: true; nonce: string | null } | { ok: false } {
  if (value === undefined) {
    return { ok: true, nonce: null };
  }
  if (value.length < 1 || value.length > NONCE_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false };
  }
  return { ok: true, nonce: value };
}

function scopeSet(scope: string): Set<string> {
  return new Set(scope.split(" ").filter((part) => part.length > 0));
}

function idTokenClaims(issuer: string, exchanged: ExchangedAuthorizationCode): IdTokenClaims {
  const iat = Math.floor(Date.now() / 1000);
  const scopes = scopeSet(exchanged.scope);
  const claims: IdTokenClaims = {
    iss: issuer,
    sub: exchanged.userId,
    aud: exchanged.clientId,
    exp: iat + ID_TOKEN_TTL_SECONDS,
    iat,
    auth_time: exchanged.authTime,
  };
  if (exchanged.nonce) {
    claims.nonce = exchanged.nonce;
  }
  if (scopes.has("email")) {
    claims.email = exchanged.email;
    claims.email_verified = false;
  }
  if (scopes.has("profile")) {
    claims.name = exchanged.name;
  }
  return claims;
}

function userInfoClaims(access: {
  sub: string;
  email: string;
  name: string;
  userStatus: "active";
  scope: string;
}): Record<string, string | boolean> {
  const scopes = scopeSet(access.scope);
  if (!scopes.has("openid")) {
    return {
      sub: access.sub,
      email: access.email,
      name: access.name,
      status: access.userStatus,
      ...(scopes.has("email") ? { email_verified: false } : {}),
    };
  }
  return {
    sub: access.sub,
    status: access.userStatus,
    ...(scopes.has("email") ? { email: access.email, email_verified: false } : {}),
    ...(scopes.has("profile") ? { name: access.name } : {}),
  };
}

function queryString(query: unknown, key: string): string | undefined {
  if (!query || typeof query !== "object" || !(key in query)) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readQuery(query: unknown, key: string): { ok: true; value: string | undefined } | { ok: false } {
  if (!query || typeof query !== "object" || !(key in query)) {
    return { ok: true, value: undefined };
  }
  const value = (query as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return { ok: false };
  }
  return { ok: true, value };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function field(body: Record<string, unknown>, camel: string, snake: string): unknown {
  if (camel in body) {
    return body[camel];
  }
  if (snake in body) {
    return body[snake];
  }
  return undefined;
}

function requiredName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("name is required"), { statusCode: 400 });
  }
  return value.trim();
}

function optionalBoolean(body: Record<string, unknown>, camel: string, snake: string): boolean | undefined {
  const value = field(body, camel, snake);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw Object.assign(new Error(`${camel} must be a boolean`), { statusCode: 400 });
  }
  return value;
}

function sendStoreError(reply: FastifyReply, error: unknown) {
  const status =
    error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
  const message = error instanceof Error ? error.message : "request failed";
  return reply.code(status).send({ error: { message, type: "viate_error" } });
}
