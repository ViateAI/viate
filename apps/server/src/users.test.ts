import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { parseOpenAIChatUsage, type JsonPostRequest, type ProviderConnection, type ProviderHandler } from "@viateai/sdk";
import type { PluginOperator } from "./admin.js";
import { buildApp, type App } from "./app.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { resetRoutingStateForTests } from "./routing.js";
import { AdminStore, type RequestLogRecord } from "./store.js";

const ORIGIN = "http://localhost:80";
const HOST = "localhost:80";

describe("password hashing", () => {
  it("uses scrypt parameters and still hashes when the stored secret is missing", () => {
    const stored = hashPassword("password1");
    assert.match(stored, /^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
    assert.equal(verifyPassword("password1", stored), true);
    assert.equal(verifyPassword("nope-nope", stored), false);
    assert.equal(verifyPassword("password1", null), false);
    assert.equal(verifyPassword("password1", "not-a-hash"), false);
  });
});

describe("AdminStore users", { concurrency: false }, () => {
  let dataDir = "";
  let store: AdminStore;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-users-"));
    store = await AdminStore.open(dataDir);
  });

  after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("creates users, hides the password hash, and rejects duplicate emails", () => {
    const created = store.createUser({ email: " Ada@Example.com ", name: " Ada ", password: "password1" });
    assert.equal(created.email, "ada@example.com");
    assert.equal(created.name, "Ada");
    assert.equal(created.status, "active");
    assert.equal(created.balanceTokens, 0);
    assert.equal(JSON.stringify(store.listUsers()).includes("password"), false);
    assert.equal(JSON.stringify(store.listUsers()).includes("scrypt"), false);
    assert.equal(store.listUsers()[0]?.id, created.id);

    assert.throws(
      () => store.createUser({ email: "ada@example.com", name: "Other", password: "password1" }),
      (error: unknown) => statusCode(error) === 409 && error instanceof Error && /email already exists/.test(error.message),
    );
  });

  it("grants tokens and rejects an adjust that would go below zero", () => {
    const user = store.createUser({ email: "grant@example.com", name: "Grant", password: "password1" });
    const granted = store.grantTokens(user.id, 10, " top up ");
    assert.equal(granted.user.balanceTokens, 10);
    assert.equal(granted.entry.reason, "grant");
    assert.equal(granted.entry.delta, 10);
    assert.equal(granted.entry.note, "top up");
    assert.equal(granted.entry.requestId, null);

    const adjusted = store.grantTokens(user.id, -4, "fix");
    assert.equal(adjusted.user.balanceTokens, 6);
    assert.equal(adjusted.entry.reason, "adjust");

    assert.throws(
      () => store.grantTokens(user.id, -7),
      (error: unknown) => statusCode(error) === 400,
    );
    assert.equal(store.getUser(user.id)?.balanceTokens, 6);
    assert.equal(store.listLedger(user.id).length, 2);
  });

  it("blocks admission at balance 0 while one request is in flight and when the user is disabled", () => {
    const user = store.createUser({ email: "admit@example.com", name: "Admit", password: "password1" });
    assert.throws(() => store.admitUser(user.id), (error: unknown) => statusCode(error) === 402);

    store.grantTokens(user.id, 1);
    store.admitUser(user.id);
    assert.equal(readInflight(dataDir, user.id), 1);
    store.grantTokens(user.id, -1);
    assert.equal(store.getUser(user.id)?.balanceTokens, 0);
    assert.throws(() => store.admitUser(user.id), (error: unknown) => statusCode(error) === 402);

    store.settleUsage({ userId: user.id, requestId: "admit-release", inputTokens: 0, outputTokens: 0 });
    assert.equal(readInflight(dataDir, user.id), 0);

    store.updateUser(user.id, { status: "disabled" });
    assert.throws(
      () => store.admitUser(user.id),
      (error: unknown) => statusCode(error) === 403 && error instanceof Error && error.message === "user disabled",
    );
    assert.throws(() => store.assertUserActive(user.id), (error: unknown) => statusCode(error) === 403);
    store.updateUser(user.id, { status: "active" });
    store.assertUserActive(user.id);
  });

  it("settles input plus output once, releases inflight, and allows a negative balance", () => {
    const user = store.createUser({ email: "settle@example.com", name: "Settle", password: "password1" });
    store.grantTokens(user.id, 1);
    store.admitUser(user.id);
    store.settleUsage({
      userId: user.id,
      requestId: "req-once",
      inputTokens: 3,
      outputTokens: 2,
    });
    store.settleUsage({
      userId: user.id,
      requestId: "req-once",
      inputTokens: 100,
      outputTokens: 100,
    });
    assert.equal(store.getUser(user.id)?.balanceTokens, -4);
    assert.equal(readInflight(dataDir, user.id), 0);
    const usage = store.listLedger(user.id).filter((entry) => entry.reason === "usage");
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.delta, -5);
    assert.equal(usage[0]?.requestId, "req-once");
    assert.throws(() => store.admitUser(user.id), (error: unknown) => statusCode(error) === 402);

    store.grantTokens(user.id, 10);
    store.admitUser(user.id);
    store.settleUsage({ userId: user.id, requestId: "req-bad", inputTokens: Number.NaN, outputTokens: 1.5 });
    assert.equal(store.getUser(user.id)?.balanceTokens, 6);
    assert.equal(readInflight(dataDir, user.id), 0);
  });

  it("keeps unbound keys unbound and verifies a key bound to a user", () => {
    const user = store.createUser({ email: "keys@example.com", name: "Keys", password: "password1" });
    const legacy = store.createApiKey("legacy");
    assert.equal(legacy.apiKey.userId, null);
    assert.equal(store.verifyApiKey(legacy.secret)?.userId, null);

    const bound = store.createApiKey("bound", user.id);
    assert.equal(store.verifyApiKey(bound.secret)?.userId, user.id);
    assert.equal(store.listApiKeys(user.id).some((key) => key.id === bound.apiKey.id), true);
    assert.equal(store.listApiKeys(user.id).some((key) => key.id === legacy.apiKey.id), false);
    assert.throws(() => store.createApiKey("missing", "no-such-user"), (error: unknown) => statusCode(error) === 404);
  });

  it("clears inflight admissions when the store opens again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "viate-users-reopen-"));
    const opened = await AdminStore.open(dir);
    try {
      const user = opened.createUser({ email: "crash@example.com", name: "Crash", password: "password1" });
      opened.grantTokens(user.id, 1);
      opened.admitUser(user.id);
      assert.equal(readInflight(dir, user.id), 1);
      opened.close();
      const reopened = await AdminStore.open(dir);
      try {
        assert.equal(readInflight(dir, user.id), 0);
        reopened.admitUser(user.id);
        assert.equal(readInflight(dir, user.id), 1);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("customer admin and portal HTTP", { concurrency: false }, () => {
  let dataDir = "";
  let store: AdminStore;
  let app: App;
  let upstream: TestServer;

  before(async () => {
    resetRoutingStateForTests();
    dataDir = await mkdtemp(join(tmpdir(), "viate-users-http-"));
    store = await AdminStore.open(dataDir);
    upstream = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-billed",
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100 } },
        }),
      );
    });
    enablePublished(store, { baseUrl: upstream.url, apiKey: "env-key" });
    app = await buildApp({
      logger: false,
      pluginManager: emptyPlugins(),
      providers: [billingProvider()],
      store,
      adminPassword: "correct-horse",
      adminEnabled: true,
    });
  });

  after(async () => {
    await app.close();
    await upstream.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("requires admin auth for user routes and omits the password hash", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/admin/users" });
    assert.equal(anon.statusCode, 401);

    const session = await loginAdmin(app);
    const created = await authed(app, session, {
      method: "POST",
      url: "/api/admin/users",
      payload: { email: "ada@example.com", name: "Ada", password: "password1" },
    });
    assert.equal(created.statusCode, 200);
    const user = created.json().user as { id: string; email: string; password_hash?: string };
    assert.equal(user.email, "ada@example.com");
    assert.equal("password_hash" in user, false);

    const granted = await authed(app, session, {
      method: "POST",
      url: `/api/admin/users/${user.id}/tokens`,
      payload: { delta: 100, note: "seed" },
    });
    assert.equal(granted.statusCode, 200);
    assert.equal(granted.json().user.balanceTokens, 100);

    const tooFar = await authed(app, session, {
      method: "POST",
      url: `/api/admin/users/${user.id}/tokens`,
      payload: { delta: -1000 },
    });
    assert.equal(tooFar.statusCode, 400);

    const listed = await authed(app, session, { method: "GET", url: "/api/admin/users" });
    assert.equal(listed.statusCode, 200);
    assert.equal(JSON.stringify(listed.json()).includes("password"), false);

    const ledger = await authed(app, session, { method: "GET", url: `/api/admin/users/${user.id}/ledger` });
    assert.equal(ledger.statusCode, 200);
    assert.equal(ledger.json().ledger.length, 1);
  });

  it("logs a customer in, enforces CSRF, and isolates portal keys", async () => {
    const session = await loginAdmin(app);
    await authed(app, session, {
      method: "POST",
      url: "/api/admin/users",
      payload: { email: "portal-a@example.com", name: "A", password: "password1" },
    });
    await authed(app, session, {
      method: "POST",
      url: "/api/admin/users",
      payload: { email: "portal-b@example.com", name: "B", password: "password1" },
    });

    const wrong = await app.inject({
      method: "POST",
      url: "/api/portal/login",
      headers: originHeaders(),
      payload: { email: "portal-a@example.com", password: "nope-nope" },
    });
    assert.equal(wrong.statusCode, 401);

    const login = await loginPortal(app, "portal-a@example.com", "password1");
    const seen = await app.inject({
      method: "GET",
      url: "/api/portal/session",
      headers: { cookie: login.cookie },
    });
    assert.equal(seen.statusCode, 200);
    assert.equal(seen.json().user.email, "portal-a@example.com");
    assert.equal(seen.json().csrf, login.csrf);

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/portal/keys",
      headers: { ...originHeaders(), cookie: login.cookie },
      payload: { name: "cli" },
    });
    assert.equal(noCsrf.statusCode, 403);

    const created = await portal(app, login, { method: "POST", url: "/api/portal/keys", payload: { name: "cli" } });
    assert.equal(created.statusCode, 200);
    assert.match(created.json().secret, /^viate_/);
    const keyId = created.json().apiKey.id as string;

    const other = await loginPortal(app, "portal-b@example.com", "password1");
    const foreign = await portal(app, other, { method: "DELETE", url: `/api/portal/keys/${keyId}` });
    assert.equal(foreign.statusCode, 404);
    const otherKeys = await portal(app, other, { method: "GET", url: "/api/portal/keys" });
    assert.equal(otherKeys.json().apiKeys.length, 0);
    const ownKeys = await portal(app, login, { method: "GET", url: "/api/portal/keys" });
    assert.equal(ownKeys.json().apiKeys.length, 1);
    assert.equal(ownKeys.json().apiKeys[0].userId, seen.json().user.id);

    const disabled = await authed(app, session, {
      method: "PATCH",
      url: `/api/admin/users/${seen.json().user.id}`,
      payload: { status: "disabled" },
    });
    assert.equal(disabled.statusCode, 200);
    const blocked = await app.inject({
      method: "POST",
      url: "/api/portal/login",
      headers: originHeaders(),
      payload: { email: "portal-a@example.com", password: "password1" },
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error.message, "user disabled");
    const stale = await portal(app, login, { method: "GET", url: "/api/portal/usage" });
    assert.equal(stale.statusCode, 403);
  });

  it("leaves unbound keys unchanged, bills a bound chat once, and blocks an empty balance", async () => {
    const unbound = store.createApiKey("unbound").secret;
    const openChat = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${unbound}` },
      payload: { model: "demo", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(openChat.statusCode, 200);
    const unboundLogs = await waitForLogs(store, (rows) => rows.some((row) => row.apiKeyPrefix === unbound.slice(0, 12)));
    assert.equal(unboundLogs.find((row) => row.apiKeyPrefix === unbound.slice(0, 12))?.userId ?? null, null);

    const broke = store.createUser({ email: "broke@example.com", name: "Broke", password: "password1" });
    const brokeKey = store.createApiKey("broke", broke.id).secret;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${brokeKey}` },
      payload: { model: "demo", messages: [] },
    });
    assert.equal(denied.statusCode, 402);
    assert.equal(denied.json().error.type, "viate_error");
    const models = await app.inject({
      method: "GET",
      url: "/v1/models?unused=1",
      headers: { authorization: `Bearer ${brokeKey}` },
    });
    assert.equal(models.statusCode, 200);
    assert.equal(models.json().object, "list");

    const payer = store.createUser({ email: "payer@example.com", name: "Payer", password: "password1" });
    store.grantTokens(payer.id, 1);
    const payerKey = store.createApiKey("payer", payer.id).secret;
    const missing = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${payerKey}` },
      payload: { model: "missing", messages: [] },
    });
    assert.equal(missing.statusCode, 404);
    const billed = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${payerKey}` },
      payload: { model: "demo", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(billed.statusCode, 200);
    await waitForUser(store, payer.id, -24);
    const usageRows = store.listLedger(payer.id).filter((entry) => entry.reason === "usage");
    assert.equal(usageRows.length, 1);
    assert.equal(usageRows[0]?.delta, -25);
    const payerLogs = await waitForLogs(
      store,
      (rows) => rows.some((row) => row.userId === payer.id && row.status === 200 && row.inputTokens === 20),
    );
    assert.equal(
      payerLogs.some((row) => row.userId === payer.id && row.outputTokens === 5 && row.inputTokens === 20),
      true,
    );

    store.updateUser(payer.id, { status: "disabled" });
    const disabledChat = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${payerKey}` },
      payload: { model: "demo", messages: [] },
    });
    assert.equal(disabledChat.statusCode, 403);
    assert.equal(disabledChat.json().error.message, "user disabled");
    const disabledModels = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${payerKey}` },
    });
    assert.equal(disabledModels.statusCode, 403);
  });

  it("does not reserve a token for an invalid JSON body or an unknown route", async () => {
    const user = store.createUser({ email: "stuck@example.com", name: "Stuck", password: "password1" });
    store.grantTokens(user.id, 1);
    const secret = store.createApiKey("stuck", user.id).secret;
    const chat = {
      method: "POST" as const,
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${secret}` },
      payload: { model: "demo", messages: [{ role: "user", content: "hi" }] },
    };

    const bad = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      payload: "{",
    });
    assert.ok(bad.statusCode >= 400 && bad.statusCode < 500);
    assert.notEqual(bad.statusCode, 402);

    const afterBad = await app.inject(chat);
    assert.notEqual(afterBad.statusCode, 402);

    await waitForUser(store, user.id, -24);
    store.grantTokens(user.id, 25);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/not-a-route",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      payload: { model: "demo" },
    });
    assert.equal(missing.statusCode, 404);

    const afterMissing = await app.inject(chat);
    assert.notEqual(afterMissing.statusCode, 402);
  });

  it("serves the portal without the admin password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "viate-portal-open-"));
    const openStore = await AdminStore.open(dir);
    openStore.createUser({ email: "open@example.com", name: "Open", password: "password1" });
    const openApp = await buildApp({
      logger: false,
      pluginManager: emptyPlugins(),
      store: openStore,
      adminPassword: null,
      adminEnabled: false,
    });
    try {
      const admin = await openApp.inject({ method: "GET", url: "/api/admin/users" });
      assert.equal(admin.statusCode, 503);
      const login = await loginPortal(openApp, "open@example.com", "password1");
      assert.equal(login.user.email, "open@example.com");
    } finally {
      await openApp.close();
      openStore.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function statusCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    return Number((error as { statusCode: unknown }).statusCode);
  }
  return undefined;
}

function readInflight(dataDir: string, userId: string): number {
  const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
  try {
    const row = db.prepare("SELECT inflight FROM users WHERE id = ?").get(userId) as { inflight: number | bigint };
    return Number(row.inflight);
  } finally {
    db.close();
  }
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

function originHeaders(): Record<string, string> {
  return { host: HOST, origin: ORIGIN };
}

type Session = { cookie: string; csrf: string; user: { id: string; email: string } };

async function loginAdmin(app: App): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: originHeaders(),
    payload: { password: "correct-horse" },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response.headers["set-cookie"]), csrf: response.json().csrf as string, user: { id: "", email: "" } };
}

async function loginPortal(app: App, email: string, password: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/portal/login",
    headers: originHeaders(),
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200);
  const cookies = response.headers["set-cookie"];
  const joined = Array.isArray(cookies) ? cookies.join("\n") : String(cookies ?? "");
  assert.match(joined, /viate_user=/);
  assert.match(joined, /HttpOnly/i);
  assert.match(joined, /SameSite=Strict/i);
  return {
    cookie: cookieHeader(cookies),
    csrf: response.json().csrf as string,
    user: response.json().user as { id: string; email: string },
  };
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

async function portal(
  app: App,
  session: Session,
  options: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: Record<string, unknown> },
) {
  return authed(app, session, options);
}

async function waitForUser(store: AdminStore, userId: string, balance: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (store.getUser(userId)?.balanceTokens === balance) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(store.getUser(userId)?.balanceTokens, balance);
}

async function waitForLogs(
  store: AdminStore,
  ready: (rows: RequestLogRecord[]) => boolean,
): Promise<RequestLogRecord[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = store.listRequestLogs();
    if (ready(rows)) {
      return rows;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return store.listRequestLogs();
}

function enablePublished(store: AdminStore, credentials: { baseUrl: string; apiKey: string }): void {
  const created = store.createConnection("openai-compatible");
  store.putCredentials(created.id, credentials, "primary");
  store.setActive(created.id, true);
  store.replaceConnectionModels(created.id, [{ id: "demo" }]);
}

function billingProvider(): ProviderHandler {
  return {
    id: "openai-compatible",
    async chatCompletions(request: JsonPostRequest, providerConnection: ProviderConnection) {
      const credentials = providerConnection.credentials as { baseUrl: string; apiKey?: string };
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (credentials.apiKey) {
        headers.authorization = `Bearer ${credentials.apiKey}`;
      }
      const upstream = await fetch(`${credentials.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(request.body ?? {}),
        signal: request.signal,
      });
      const contentType = upstream.headers.get("content-type");
      const responseHeaders: Record<string, string> = {};
      if (contentType) {
        responseHeaders["content-type"] = contentType;
      }
      return {
        status: upstream.status,
        headers: responseHeaders,
        body: upstream.body,
        parseUsage: parseOpenAIChatUsage,
      };
    },
  };
}

type TestServer = { url: string; close(): Promise<void> };

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  const { promise, resolve, reject } = Promise.withResolvers<TestServer>();
  const server: Server = createServer(handler);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("expected tcp address"));
      return;
    }
    resolve({
      url: `http://127.0.0.1:${address.port}`,
      close() {
        const { promise: closed, resolve: done } = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close(() => done());
        return closed;
      },
    });
  });
  server.on("error", reject);
  return promise;
}
