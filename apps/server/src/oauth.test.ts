import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { PluginOperator } from "./admin.js";
import { buildApp, type App } from "./app.js";
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
});

async function issueUserTokens(app: App, client: { client: { id: string }; secret: string }) {
  const { verifier, challenge } = pkcePair();
  const code = await authorizationCode(app, client.client.id, "https://app.example/callback", challenge);
  const issued = await token(app, {
    grant_type: "authorization_code",
    code,
    redirect_uri: "https://app.example/callback",
    code_verifier: verifier,
    client_id: client.client.id,
    client_secret: client.secret,
  });
  assert.equal(issued.statusCode, 200);
  return issued.json() as { access_token: string; refresh_token: string };
}

async function authorizationCode(app: App, clientId: string, redirectUri: string, challenge: string, email = "ada@example.com") {
  const login = await oauthLogin(app, email, "password1");
  assert.equal(login.statusCode, 200);
  const response = await app.inject({
    method: "GET",
    url: authorizeUrl(clientId, redirectUri, challenge, "xyz"),
    headers: { cookie: cookieHeader(login.headers["set-cookie"]) },
  });
  assert.equal(response.statusCode, 302);
  const location = new URL(String(response.headers.location));
  assert.equal(location.searchParams.get("state"), "xyz");
  const code = location.searchParams.get("code");
  assert.ok(code);
  return code;
}

function authorizeUrl(clientId: string, redirectUri: string, challenge = "challenge", state?: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (state) params.set("state", state);
  return `/oauth/authorize?${params.toString()}`;
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
