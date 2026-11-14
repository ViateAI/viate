import assert from "node:assert/strict";
import { createHash, createPublicKey, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { PluginOperator } from "./admin.js";
import { buildApp, type App } from "./app.js";
import { loadOidcSigner } from "./oidc.js";
import { AdminStore } from "./store.js";

const ORIGIN = "http://localhost:80";
const HOST = "localhost:80";

type Fixture = {
  app: App;
  store: AdminStore;
  dataDir: string;
};

const open: Fixture[] = [];

async function createFixture(publicUrl: string | null = "https://viate.example"): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "viate-oauth-"));
  const store = await AdminStore.open(dataDir);
  const app = await buildApp({
    logger: false,
    store,
    adminPassword: "correct-horse",
    adminEnabled: true,
    pluginManager: emptyPlugins(),
    publicUrl,
  });
  const fixture = { app, store, dataDir };
  open.push(fixture);
  return fixture;
}

afterEach(async () => {
  const fixture = open.pop();
  if (!fixture) return;
  await fixture.app.close();
  fixture.store.close();
  await rm(fixture.dataDir, { recursive: true, force: true });
});

describe("oauth authorization server", { concurrency: false }, () => {
  it("rejects a PKCE verifier that does not match the S256 challenge", async () => {
    const { app, store } = await createFixture();
    const user = store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const client = await createClient(app, ["https://app.example/callback"]);
    const { verifier, challenge } = pkcePair();
    const code = await authorizationCode(app, client.client.id, "https://app.example/callback", challenge, user.email);
    const failed = await token(app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://app.example/callback",
      code_verifier: `${verifier}x`,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(failed.statusCode, 400);
    assert.equal(failed.json().error, "invalid_grant");
    assert.equal(failed.headers["cache-control"], "no-store");
    const recovered = await token(app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://app.example/callback",
      code_verifier: verifier,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(recovered.statusCode, 200);
    assert.match(recovered.json().access_token, /^vat_/);
  });

  it("revokes the token family when an authorization code is replayed", async () => {
    const { app, store } = await createFixture();
    store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const client = await createClient(app, ["https://app.example/callback"]);
    const { verifier, challenge } = pkcePair();
    const code = await authorizationCode(app, client.client.id, "https://app.example/callback", challenge);
    const first = await token(app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://app.example/callback",
      code_verifier: verifier,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(first.statusCode, 200);
    const replay = await token(app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://app.example/callback",
      code_verifier: verifier,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.json().error, "invalid_grant");
    const info = await app.inject({
      method: "GET",
      url: "/oauth/userinfo",
      headers: { authorization: `Bearer ${first.json().access_token}` },
    });
    assert.equal(info.statusCode, 401);
    const refresh = await token(app, {
      grant_type: "refresh_token",
      refresh_token: first.json().refresh_token,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(refresh.statusCode, 400);
    assert.equal(refresh.json().error, "invalid_grant");
  });

  it("rotates refresh tokens and revokes the family when an old refresh token is replayed", async () => {
    const { app, store } = await createFixture();
    store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const client = await createClient(app, ["https://app.example/callback"]);
    const issued = await issueUserTokens(app, client);
    const rotated = await token(app, {
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(rotated.statusCode, 200);
    assert.notEqual(rotated.json().refresh_token, issued.refresh_token);
    assert.match(rotated.json().refresh_token, /^vrt_/);
    assert.equal(rotated.json().expires_in, 3600);
    assert.equal(rotated.headers["cache-control"], "no-store");
    const replay = await token(app, {
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(replay.statusCode, 400);
    assert.match(replay.json().error_description, /replayed/);
    const next = await token(app, {
      grant_type: "refresh_token",
      refresh_token: rotated.json().refresh_token,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(next.statusCode, 400);
    assert.equal(next.json().error, "invalid_grant");
  });

  it("sends a disabled user back to login and rejects that user's token, refresh, and userinfo", async () => {
    const { app, store } = await createFixture();
    const user = store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const client = await createClient(app, ["https://app.example/callback"]);
    const { verifier, challenge } = pkcePair();
    const login = await oauthLogin(app, user.email, "password1");
    const cookie = cookieHeader(login.headers["set-cookie"]);
    store.updateUser(user.id, { status: "disabled" });
    const authorize = await app.inject({
      method: "GET",
      url: authorizeUrl(client.client.id, "https://app.example/callback", challenge),
      headers: { cookie },
    });
    assert.equal(authorize.statusCode, 302);
    assert.match(String(authorize.headers.location), /^\/portal\/oauth-login\?return=/);
    assert.equal(authorize.headers.location?.includes("code="), false);

    store.updateUser(user.id, { status: "active" });
    const activeLogin = await oauthLogin(app, user.email, "password1");
    const codeResponse = await app.inject({
      method: "GET",
      url: authorizeUrl(client.client.id, "https://app.example/callback", challenge, "state-1"),
      headers: { cookie: cookieHeader(activeLogin.headers["set-cookie"]) },
    });
    const code = new URL(String(codeResponse.headers.location)).searchParams.get("code");
    assert.ok(code);
    store.updateUser(user.id, { status: "disabled" });
    const exchanged = await token(app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://app.example/callback",
      code_verifier: verifier,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(exchanged.statusCode, 400);
    assert.equal(exchanged.json().error, "invalid_grant");

    store.updateUser(user.id, { status: "active" });
    const issued = await issueUserTokens(app, client);
    store.updateUser(user.id, { status: "disabled" });
    const info = await app.inject({
      method: "GET",
      url: "/oauth/userinfo",
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
    assert.equal(info.statusCode, 403);
    assert.equal(info.json().error, "user_inactive");
    const refresh = await token(app, {
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(refresh.statusCode, 400);
    assert.equal(refresh.json().error, "invalid_grant");
  });

  it("replaces an unsafe return path with /portal", async () => {
    const { app, store } = await createFixture();
    store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const safe = "/oauth/authorize?client_id=vc_1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb";
    const cases: Array<[string, string]> = [
      ["https://evil.example/phish", "/portal"],
      ["//evil.example", "/portal"],
      ["/\\evil.example", "/portal"],
      ["/oauth/authorize", "/portal"],
      [safe, safe],
      ["/oauth/authorize?redirect_uri=https://app.example/cb", "/oauth/authorize?redirect_uri=https://app.example/cb"],
    ];
    for (const [requested, expected] of cases) {
      const response = await app.inject({
        method: "POST",
        url: `/oauth/login?return=${encodeURIComponent(requested)}`,
        headers: originHeaders(),
        payload: { email: "ada@example.com", password: "password1" },
      });
      assert.equal(response.statusCode, 200, requested);
      assert.equal(response.json().ok, true);
      assert.equal(response.json().redirect, expected);
    }
  });

  it("requires an exact redirect URI and limits plain HTTP to loopback or an explicit opt-in", async () => {
    const { app, store } = await createFixture();
    store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const session = await loginAdmin(app);
    const rejected = await authed(app, session, {
      method: "POST",
      url: "/api/admin/oauth-clients",
      payload: { name: "Bad", redirectUris: ["http://app.example/callback"], scopes: ["users:read"] },
    });
    assert.equal(rejected.statusCode, 400);
    const fragment = await authed(app, session, {
      method: "POST",
      url: "/api/admin/oauth-clients",
      payload: { name: "Frag", redirectUris: ["https://app.example/callback#x"], scopes: [] },
    });
    assert.equal(fragment.statusCode, 400);
    for (const uri of ["http://127.0.0.1:9/callback", "http://localhost:8080/cb", "http://[::1]/cb"]) {
      const created = await authed(app, session, {
        method: "POST",
        url: "/api/admin/oauth-clients",
        payload: { name: uri, redirectUris: [uri], scopes: [] },
      });
      assert.equal(created.statusCode, 200, uri);
    }
    const allowed = await authed(app, session, {
      method: "POST",
      url: "/api/admin/oauth-clients",
      payload: {
        name: "HTTP",
        redirectUris: ["http://app.example/callback"],
        scopes: [],
        allowHttpRedirects: true,
      },
    });
    assert.equal(allowed.statusCode, 200);
    const client = await createClient(app, ["https://app.example/callback"]);
    const mismatch = await app.inject({
      method: "GET",
      url: authorizeUrl(client.client.id, "https://app.example/callback/"),
    });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.headers.location, undefined);
    assert.match(mismatch.body, /authorization request is invalid/);
    const unknown = await app.inject({
      method: "GET",
      url: authorizeUrl("vc_missing", "https://app.example/callback"),
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.headers.location, undefined);
  });

  it("sets a Lax OAuth cookie that does not authenticate the portal API", async () => {
    const { app, store } = await createFixture(null);
    const user = store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const login = await oauthLogin(app, user.email, "password1");
    const setCookie = String(login.headers["set-cookie"] ?? "");
    assert.match(setCookie, /viate_oauth=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\/oauth/i);
    assert.match(setCookie, /Max-Age=43200/);
    assert.doesNotMatch(setCookie, /Secure/i);
    const secure = await app.inject({
      method: "POST",
      url: "/oauth/login",
      headers: { host: HOST, origin: "https://localhost:80", "x-forwarded-proto": "https" },
      payload: { email: user.email, password: "password1" },
    });
    assert.match(String(secure.headers["set-cookie"]), /Secure/i);
    const portal = await app.inject({
      method: "GET",
      url: "/api/portal/session",
      headers: { cookie: cookieHeader(login.headers["set-cookie"]) },
    });
    assert.equal(portal.statusCode, 401);
    const metadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
      headers: { host: "gateway.example", "x-forwarded-proto": "https" },
    });
    assert.equal(metadata.json().issuer, "https://gateway.example");
    assert.deepEqual(metadata.json().code_challenge_methods_supported, ["S256"]);
  });

  it("shares the portal login limiter and refuses a non-first-party client", async () => {
    const { app, store } = await createFixture();
    store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/portal/login",
        headers: originHeaders(),
        payload: { email: "ada@example.com", password: "wrong-password" },
      });
      assert.equal(failed.statusCode, 401);
    }
    const limited = await oauthLogin(app, "ada@example.com", "password1");
    assert.equal(limited.statusCode, 429);
    const third = store.createOAuthClient({
      name: "Third",
      redirectUris: ["https://app.example/callback"],
      scopes: [],
      allowHttpRedirects: false,
      firstParty: false,
    });
    const response = await app.inject({
      method: "GET",
      url: authorizeUrl(third.client.id, "https://app.example/callback"),
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /consent not supported/);
    assert.equal(response.headers.location, undefined);
  });

  it("signs an id_token with the JWKS key and omits it without the openid scope", async () => {
    const { app, store, dataDir } = await createFixture();
    const keyStat = await stat(join(dataDir, "oidc-signing.key"));
    assert.equal(keyStat.mode & 0o777, 0o600);
    const user = store.createUser({ email: "ada@example.com", name: "Ada Lovelace", password: "password1" });
    const client = await createClient(app, ["https://app.example/callback"]);
    const discovery = await app.inject({ method: "GET", url: "/.well-known/openid-configuration" });
    assert.equal(discovery.statusCode, 200);
    const document = discovery.json() as Record<string, unknown>;
    assert.equal(document.issuer, "https://viate.example");
    assert.equal(document.jwks_uri, "https://viate.example/oauth/jwks");
    assert.equal(document.authorization_endpoint, "https://viate.example/oauth/authorize");
    assert.equal(document.token_endpoint, "https://viate.example/oauth/token");
    assert.deepEqual(document.subject_types_supported, ["public"]);
    assert.deepEqual(document.id_token_signing_alg_values_supported, ["ES256"]);
    assert.deepEqual(document.scopes_supported, [
      "openid",
      "email",
      "profile",
      "users:read",
      "channels:read",
      "keys:write",
      "usage:read",
    ]);
    assert.deepEqual(document.claims_supported, [
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
    ]);
    const oauthMetadata = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    const oauthScopes = oauthMetadata.json().scopes_supported as string[];
    assert.equal(oauthScopes.includes("openid"), false);
    assert.deepEqual(oauthScopes, ["profile", "users:read", "channels:read", "keys:write", "usage:read"]);

    const jwks = await app.inject({ method: "GET", url: "/oauth/jwks" });
    assert.equal(jwks.statusCode, 200);
    const keys = jwksKeys(jwks.json());
    assert.equal(keys.length, 1);
    const reloaded = await loadOidcSigner(dataDir);
    assert.deepEqual(
      reloaded.jwks().keys.map((key) => key.kid),
      keys.map((key) => key.kid),
    );

    const nonce = "nonce-原样._~";
    const before = Math.floor(Date.now() / 1000);
    const issued = await issueUserTokens(app, client, { scope: "openid email profile", nonce });
    const after = Math.floor(Date.now() / 1000);
    assert.equal(typeof issued.id_token, "string");
    assert.equal(issued.scope, "openid email profile");
    assert.equal(issued.expires_in, 3600);
    const claims = verifyIdToken(issued.id_token ?? "", jwks.json());
    assert.equal(claims.iss, "https://viate.example");
    assert.equal(claims.sub, user.id);
    assert.equal(claims.aud, client.client.id);
    assert.equal(claims.nonce, nonce);
    assert.equal(claims.email, user.email);
    assert.equal(claims.email_verified, false);
    assert.equal(typeof claims.email_verified, "boolean");
    assert.equal(claims.name, "Ada Lovelace");
    assert.equal(numberClaim(claims, "exp"), numberClaim(claims, "iat") + 600);
    assert.equal(typeof claims.auth_time, "number");
    assert.ok(numberClaim(claims, "auth_time") >= before && numberClaim(claims, "auth_time") <= after);
    assert.ok(numberClaim(claims, "iat") >= before && numberClaim(claims, "iat") <= after);

    const info = await app.inject({
      method: "GET",
      url: "/oauth/userinfo",
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
    assert.equal(info.statusCode, 200);
    assert.deepEqual(info.json(), {
      sub: user.id,
      status: "active",
      email: user.email,
      email_verified: false,
      name: "Ada Lovelace",
    });

    const refreshed = await token(app, {
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: client.client.id,
      client_secret: client.secret,
    });
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.json().id_token, undefined);
    assert.equal(refreshed.json().scope, "openid email profile");

    const plain = await issueUserTokens(app, client);
    assert.equal(plain.id_token, undefined);
    assert.equal(plain.scope, "profile");
    const plainInfo = await app.inject({
      method: "GET",
      url: "/oauth/userinfo",
      headers: { authorization: `Bearer ${plain.access_token}` },
    });
    assert.deepEqual(plainInfo.json(), {
      sub: user.id,
      email: user.email,
      name: "Ada Lovelace",
      status: "active",
    });
  });

  it("publishes every public key in the signing file and signs with the first", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-oidc-keys-"));
    try {
      const first = await loadOidcSigner(dataDir);
      const extra = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const exported = extra.privateKey.export({ type: "pkcs8", format: "pem" });
      const extraPem = typeof exported === "string" ? exported : exported.toString("utf8");
      const current = await readFile(join(dataDir, "oidc-signing.key"), "utf8");
      await writeFile(join(dataDir, "oidc-signing.key"), `${current}\n${extraPem}`, { mode: 0o600 });
      const both = await loadOidcSigner(dataDir);
      const body = both.jwks();
      assert.equal(body.keys.length, 2);
      assert.equal(body.keys[0]?.kid, first.jwks().keys[0]?.kid);
      assert.notEqual(body.keys[1]?.kid, body.keys[0]?.kid);
      const signed = both.sign({
        iss: "https://viate.example",
        sub: "user",
        aud: "client",
        exp: 1_800_000_600,
        iat: 1_800_000_000,
        auth_time: 1_800_000_000,
        nonce: "nonce-原样._~",
        email: "ada@example.com",
        email_verified: false,
        name: "Ada Lovelace",
      });
      const claims = verifyIdToken(signed, body);
      assert.equal(claims.nonce, "nonce-原样._~");
      assert.equal(claims.email_verified, false);
      const header = decodeJson(signed.split(".")[0] ?? "");
      assert.equal(header.kid, body.keys[0]?.kid);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("adds nonce and auth_time columns to authorization codes created before oidc", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-oidc-migrate-"));
    try {
      const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
      db.exec(`CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      )`);
      db.close();
      const store = await AdminStore.open(dataDir);
      store.close();
      const check = new DatabaseSync(join(dataDir, "viate.sqlite"));
      const columns = check.prepare("PRAGMA table_info(oauth_codes)").all();
      check.close();
      const names = columns.map((column) => column.name);
      assert.ok(names.includes("nonce"));
      assert.ok(names.includes("auth_time"));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

async function issueUserTokens(
  app: App,
  client: { client: { id: string }; secret: string },
  extra?: { scope?: string; nonce?: string },
) {
  const { verifier, challenge } = pkcePair();
  const code = await authorizationCode(app, client.client.id, "https://app.example/callback", challenge, "ada@example.com", extra);
  const issued = await token(app, {
    grant_type: "authorization_code",
    code,
    redirect_uri: "https://app.example/callback",
    code_verifier: verifier,
    client_id: client.client.id,
    client_secret: client.secret,
  });
  assert.equal(issued.statusCode, 200);
  return issued.json() as { access_token: string; refresh_token: string; id_token?: string; scope: string; expires_in: number };
}

async function authorizationCode(
  app: App,
  clientId: string,
  redirectUri: string,
  challenge: string,
  email = "ada@example.com",
  extra?: { scope?: string; nonce?: string },
) {
  const login = await oauthLogin(app, email, "password1");
  assert.equal(login.statusCode, 200);
  const response = await app.inject({
    method: "GET",
    url: authorizeUrl(clientId, redirectUri, challenge, "xyz", extra),
    headers: { cookie: cookieHeader(login.headers["set-cookie"]) },
  });
  assert.equal(response.statusCode, 302);
  const location = new URL(String(response.headers.location));
  assert.equal(location.searchParams.get("state"), "xyz");
  const code = location.searchParams.get("code");
  assert.ok(code);
  return code;
}

function authorizeUrl(
  clientId: string,
  redirectUri: string,
  challenge = "challenge",
  state?: string,
  extra?: { scope?: string; nonce?: string },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (state) params.set("state", state);
  if (extra?.scope) params.set("scope", extra.scope);
  if (extra?.nonce) params.set("nonce", extra.nonce);
  return `/oauth/authorize?${params.toString()}`;
}

function jwksKeys(body: unknown): Array<{ kid: string; x: string; y: string }> {
  assert.ok(body && typeof body === "object" && !Array.isArray(body));
  const keys = "keys" in body ? body.keys : undefined;
  assert.ok(Array.isArray(keys) && keys.length > 0);
  const parsed: Array<{ kid: string; x: string; y: string }> = [];
  for (const key of keys) {
    assert.ok(key && typeof key === "object" && !Array.isArray(key));
    assert.equal("d" in key, false);
    assert.equal("kty" in key ? key.kty : undefined, "EC");
    assert.equal("crv" in key ? key.crv : undefined, "P-256");
    assert.equal("alg" in key ? key.alg : undefined, "ES256");
    const kid = "kid" in key ? key.kid : undefined;
    const x = "x" in key ? key.x : undefined;
    const y = "y" in key ? key.y : undefined;
    assert.equal(typeof kid, "string");
    assert.equal(typeof x, "string");
    assert.equal(typeof y, "string");
    if (typeof kid !== "string" || typeof x !== "string" || typeof y !== "string") {
      assert.fail("jwk fields are not strings");
    }
    assert.equal(x.includes("="), false);
    assert.equal(y.includes("="), false);
    const thumbprint = createHash("sha256").update(JSON.stringify({ crv: "P-256", kty: "EC", x, y })).digest("base64url");
    assert.equal(kid, thumbprint);
    parsed.push({ kid, x, y });
  }
  return parsed;
}

function verifyIdToken(token: string, jwks: unknown): Record<string, unknown> {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  assert.ok(encodedHeader && encodedPayload && encodedSignature);
  const header = decodeJson(encodedHeader);
  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "JWT");
  const kid = header.kid;
  assert.equal(typeof kid, "string");
  if (typeof kid !== "string") {
    assert.fail("kid is not a string");
  }
  const jwk = jwksKeys(jwks).find((key) => key.kid === kid);
  assert.ok(jwk);
  const signature = Buffer.from(encodedSignature, "base64url");
  assert.equal(signature.length, 64);
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
  const verifier = createVerify("SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  assert.equal(verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, signature), true);
  const flipped = Buffer.from(signature);
  const first = flipped[0] ?? 0;
  flipped[0] = first ^ 0xff;
  const rejected = createVerify("SHA256");
  rejected.update(`${encodedHeader}.${encodedPayload}`);
  rejected.end();
  assert.equal(rejected.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, flipped), false);
  return decodeJson(encodedPayload);
}

function decodeJson(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function numberClaim(claims: Record<string, unknown>, key: string): number {
  const value = claims[key];
  assert.equal(typeof value, "number");
  if (typeof value !== "number") {
    assert.fail(`${key} is not a number`);
  }
  return value;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function createClient(app: App, redirectUris: string[]) {
  const session = await loginAdmin(app);
  const response = await authed(app, session, {
    method: "POST",
    url: "/api/admin/oauth-clients",
    payload: { name: "Bot", redirectUris, scopes: ["users:read", "keys:write"] },
  });
  assert.equal(response.statusCode, 200);
  return response.json() as { client: { id: string }; secret: string };
}

async function oauthLogin(app: App, email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/oauth/login",
    headers: originHeaders(),
    payload: { email, password },
  });
}

async function token(app: App, payload: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(payload).toString(),
  });
}

function originHeaders(): Record<string, string> {
  return { host: HOST, origin: ORIGIN };
}

type Session = { cookie: string; csrf: string };

async function loginAdmin(app: App): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: originHeaders(),
    payload: { password: "correct-horse" },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response.headers["set-cookie"]), csrf: response.json().csrf as string };
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.map((part) => String(part).split(";")[0]).join("; ");
}

async function authed(
  app: App,
  session: Session,
  options: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: Record<string, unknown> },
) {
  return app.inject({
    method: options.method,
    url: options.url,
    headers: {
      ...originHeaders(),
      cookie: session.cookie,
      ...(options.method === "GET" ? {} : { "x-viate-csrf": session.csrf }),
    },
    payload: options.payload,
  });
}

function emptyPlugins(): PluginOperator {
  return {
    async list() {
      return [];
    },
    async add() {
      return [];
    },
    async update() {
      return [];
    },
    async remove() {
      return [];
    },
  };
}
