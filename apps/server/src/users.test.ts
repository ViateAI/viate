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
    assert.equal(created.balanceUsd, "0.00");
    assert.equal("balanceTokens" in created, false);
    assert.equal(JSON.stringify(store.listUsers()).includes("password"), false);
    assert.equal(JSON.stringify(store.listUsers()).includes("scrypt"), false);
    assert.equal(store.listUsers()[0]?.id, created.id);

    assert.throws(
      () => store.createUser({ email: "ada@example.com", name: "Other", password: "password1" }),
      (error: unknown) => statusCode(error) === 409 && error instanceof Error && /email already exists/.test(error.message),
    );
  });

  it("grants dollars and rejects a zero, exponent, or debit below zero", () => {
    const user = store.createUser({ email: "grant@example.com", name: "Grant", password: "password1" });
    const granted = store.grantUsd(user.id, "10.50", " top up ");
    assert.equal(granted.user.balanceUsd, "10.50");
    assert.equal("balanceTokens" in granted.user, false);
    assert.equal(granted.entry.reason, "grant");
    assert.equal(granted.entry.deltaUsd, "10.50");
    assert.equal(granted.entry.balanceAfterUsd, "10.50");
    assert.equal("delta" in granted.entry, false);
    assert.equal("balanceAfter" in granted.entry, false);
    assert.equal(granted.entry.note, "top up");
    assert.equal(granted.entry.requestId, null);

    const adjusted = store.grantUsd(user.id, "-0.50", "fix");
    assert.equal(adjusted.user.balanceUsd, "10.00");
    assert.equal(adjusted.entry.reason, "adjust");
    assert.equal(adjusted.entry.deltaUsd, "-0.50");

    assert.throws(
      () => store.grantUsd(user.id, "-10.01"),
      (error: unknown) =>
        statusCode(error) === 400 && error instanceof Error && error.message === "balance cannot be negative",
    );
    assert.throws(() => store.grantUsd(user.id, "0"), (error: unknown) => statusCode(error) === 400);
    assert.throws(() => store.grantUsd(user.id, "1e2"), (error: unknown) => statusCode(error) === 400);
    assert.equal(store.getUser(user.id)?.balanceUsd, "10.00");
    assert.equal(store.listLedger(user.id).length, 2);
  });

  it("blocks admission at balance 0, at eight in-flight calls, and when the user is disabled", () => {
    const user = store.createUser({ email: "admit@example.com", name: "Admit", password: "password1" });
    assert.throws(
      () => store.admitUser(user.id),
      (error: unknown) =>
        statusCode(error) === 402 && error instanceof Error && error.message === "insufficient balance",
    );

    store.grantUsd(user.id, "1.00");
    for (let i = 0; i < 8; i += 1) {
      store.admitUser(user.id);
    }
    assert.equal(readInflight(dataDir, user.id), 8);
    assert.throws(() => store.admitUser(user.id), (error: unknown) => statusCode(error) === 402);
    store.grantUsd(user.id, "-1.00");
    assert.equal(store.getUser(user.id)?.balanceUsd, "0.00");
    assert.throws(() => store.admitUser(user.id), (error: unknown) => statusCode(error) === 402);

    for (let i = 0; i < 8; i += 1) {
      store.settleUsage({
        userId: user.id,
        requestId: `admit-release-${i}`,
        inputTokens: 0,
        outputTokens: 0,
        inputNanoPerMillion: 0,
        outputNanoPerMillion: 0,
      });
    }
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

  it("settles the worked example once, releases inflight, and allows a negative balance", () => {
    const user = store.createUser({ email: "settle@example.com", name: "Settle", password: "password1" });
    store.grantUsd(user.id, "1.00");
    store.admitUser(user.id);
    store.settleUsage({
      userId: user.id,
      requestId: "req-once",
      inputTokens: 1000,
      outputTokens: 100,
      inputNanoPerMillion: 3_000_000_000,
      outputNanoPerMillion: 15_000_000_000,
    });
    store.settleUsage({
      userId: user.id,
      requestId: "req-once",
      inputTokens: 100,
      outputTokens: 100,
      inputNanoPerMillion: 3_000_000_000,
      outputNanoPerMillion: 15_000_000_000,
    });
    assert.equal(readBalanceNano(dataDir, user.id), 1_000_000_000 - 4_500_000);
    assert.equal(store.getUser(user.id)?.balanceUsd, "0.9955");
    assert.equal(readInflight(dataDir, user.id), 0);
    const usage = store.listLedger(user.id).filter((entry) => entry.reason === "usage");
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.deltaUsd, "-0.0045");
    assert.equal(usage[0]?.balanceAfterUsd, "0.9955");
    assert.equal(usage[0]?.requestId, "req-once");

    store.admitUser(user.id);
    store.settleUsage({
      userId: user.id,
      requestId: "req-half",
      inputTokens: 1,
      outputTokens: 0,
      inputNanoPerMillion: 500_000,
      outputNanoPerMillion: 0,
    });
    assert.equal(readBalanceNano(dataDir, user.id), 1_000_000_000 - 4_500_000 - 1);
    assert.equal(readInflight(dataDir, user.id), 0);

    const beforeBad = readBalanceNano(dataDir, user.id);
    store.admitUser(user.id);
    store.settleUsage({
      userId: user.id,
      requestId: "req-bad",
      inputTokens: Number.NaN,
      outputTokens: 1.5,
      inputNanoPerMillion: 3_000_000_000,
      outputNanoPerMillion: 15_000_000_000,
    });
    assert.equal(readBalanceNano(dataDir, user.id), beforeBad);
    assert.equal(readInflight(dataDir, user.id), 0);

    store.admitUser(user.id);
    store.settleUsage({
      userId: user.id,
      requestId: "req-negative",
      inputTokens: 1_000_000,
      outputTokens: 0,
      inputNanoPerMillion: 3_000_000_000,
      outputNanoPerMillion: 0,
    });
    assert.equal(store.getUser(user.id)?.balanceUsd, "-2.004500001");
    assert.equal(readInflight(dataDir, user.id), 0);
    assert.throws(() => store.admitUser(user.id), (error: unknown) => statusCode(error) === 402);
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
      opened.grantUsd(user.id, "1.00");
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

  it("adds balance_nano without copying an old token balance", async () => {
    const fresh = new DatabaseSync(join(dataDir, "viate.sqlite"));
    try {
      const names = (fresh.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((column) => column.name);
      assert.equal(names.includes("balance_nano"), true);
      assert.equal(names.includes("balance_tokens"), false);
    } finally {
      fresh.close();
    }

    const dir = await mkdtemp(join(tmpdir(), "viate-users-legacy-"));
    const legacy = new DatabaseSync(join(dir, "viate.sqlite"));
    const now = new Date().toISOString();
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        balance_tokens INTEGER NOT NULL DEFAULT 0,
        inflight INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO users (
          id, email, name, password_hash, status, balance_tokens, inflight, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', 42, 3, ?, ?)`,
      )
      .run("user-old", "old@example.com", "Old", "hash", now, now);
    legacy.close();
    const opened = await AdminStore.open(dir);
    try {
      assert.equal(opened.getUser("user-old")?.balanceUsd, "0.00");
      const check = new DatabaseSync(join(dir, "viate.sqlite"));
      try {
        const row = check.prepare("SELECT balance_tokens, balance_nano, inflight FROM users WHERE id = ?").get("user-old") as {
          balance_tokens: number | bigint;
          balance_nano: number | bigint;
          inflight: number | bigint;
        };
        assert.equal(Number(row.balance_tokens), 42);
        assert.equal(Number(row.balance_nano), 0);
        assert.equal(Number(row.inflight), 0);
      } finally {
        check.close();
      }
    } finally {
      opened.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("customer admin and portal HTTP", { concurrency: false }, () => {
  let dataDir = "";
  let store: AdminStore;
  let app: App;
  let upstream: TestServer;
  let upstreamCalls = 0;

  before(async () => {
    resetRoutingStateForTests();
    dataDir = await mkdtemp(join(tmpdir(), "viate-users-http-"));
    store = await AdminStore.open(dataDir);
    upstream = await listen((_req, res) => {
      upstreamCalls += 1;
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
      modelPrices: demoModelPrices(),
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

    const zero = await authed(app, session, {
      method: "POST",
      url: `/api/admin/users/${user.id}/balance`,
      payload: { usd: "0" },
    });
    assert.equal(zero.statusCode, 400);
    const exponent = await authed(app, session, {
      method: "POST",
      url: `/api/admin/users/${user.id}/balance`,
      payload: { usd: "1e2" },
    });
    assert.equal(exponent.statusCode, 400);
    const retired = await authed(app, session, {
      method: "POST",
      url: `/api/admin/users/${user.id}/tokens`,
      payload: { delta: 100 },
    });
    assert.equal(retired.statusCode, 404);

    const granted = await authed(app, session, {
      method: "POST",
      url: `/api/admin/users/${user.id}/balance`,
      payload: { usd: "10.50", note: "seed" },
    });
    assert.equal(granted.statusCode, 200);
    assert.equal(granted.json().user.balanceUsd, "10.50");
    assert.equal(granted.json().entry.deltaUsd, "10.50");

    const tooFar = await authed(app, session, {
      method: "POST",
      url: `/api/admin/users/${user.id}/balance`,
      payload: { usd: "-11.00" },
    });
    assert.equal(tooFar.statusCode, 400);
    assert.equal(tooFar.json().error.message, "balance cannot be negative");

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

    const channel = store.createChannel({ name: "Portal", ratio: "1", rule: { kind: "all" } });
    store.setUserChannels(seen.json().user.id as string, [channel.id]);
    const created = await portal(app, login, {
      method: "POST",
      url: "/api/portal/keys",
      payload: { name: "cli", channelId: channel.id },
    });
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

  it("returns granted channel catalogs without ratio or match rules", async () => {
    const user = store.createUser({
      email: "portal-channels@example.com",
      name: "Channels",
      password: "password1",
    });
    const login = await loginPortal(app, "portal-channels@example.com", "password1");
    const granted = store.createChannel({
      name: "Granted",
      ratio: "2",
      rule: { kind: "models", modelIds: ["portal-only"] },
    });
    const hidden = store.createChannel({ name: "Other", ratio: "3", rule: { kind: "all" } });
    store.setUserChannels(user.id, [granted.id]);

    const response = await portal(app, login, { method: "GET", url: "/api/portal/channels" });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      channels: Array<{ id: string; name: string; models: Array<{ id: string; endpoints: string[] }> }>;
    };
    const encoded = JSON.stringify(body);
    assert.equal(encoded.includes("ratio"), false);
    assert.equal(encoded.includes("rule"), false);
    assert.equal(encoded.includes("owned_by"), false);
    assert.equal(encoded.includes("children"), false);
    assert.deepEqual(
      body.channels.map((channel) => channel.id),
      [granted.id],
    );
    assert.equal(body.channels.some((channel) => channel.id === hidden.id), false);
    const catalog = store.listChannelCatalog(granted).data;
    assert.deepEqual(
      body.channels[0]?.models.map((model) => model.id),
      catalog.map((model) => model.id),
    );
    assert.deepEqual(
      body.channels[0]?.models.map((model) => model.endpoints),
      catalog.map((model) => model.supported_endpoint_types),
    );
    assert.equal(store.listPublicCatalog().data.some((model) => model.id === "demo"), true);
    assert.equal(body.channels[0]?.models.some((model) => model.id === "demo"), false);
    assert.deepEqual(body.channels[0]?.models, []);
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
    assert.equal(denied.json().error.message, "insufficient balance");
    const models = await app.inject({
      method: "GET",
      url: "/v1/models?unused=1",
      headers: { authorization: `Bearer ${brokeKey}` },
    });
    assert.equal(models.statusCode, 200);
    assert.equal(models.json().object, "list");

    const payer = store.createUser({ email: "payer@example.com", name: "Payer", password: "password1" });
    store.grantUsd(payer.id, "1.00");
    const payerKey = store.createApiKey("payer", payer.id).secret;
    const beforeMissing = upstreamCalls;
    const missing = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${payerKey}` },
      payload: { model: "missing", messages: [] },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.message, "model price unavailable");
    assert.equal(upstreamCalls, beforeMissing);
    assert.equal(store.getUser(payer.id)?.balanceUsd, "1.00");
    assert.equal(readInflight(dataDir, payer.id), 0);
    const unlisted = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${payerKey}` },
      payload: { model: "unlisted", messages: [] },
    });
    assert.equal(unlisted.statusCode, 404);
    assert.equal(upstreamCalls, beforeMissing);
    assert.equal(readInflight(dataDir, payer.id), 0);
    const billed = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${payerKey}` },
      payload: { model: "demo", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(billed.statusCode, 200);
    await waitForUser(store, payer.id, "0.999975");
    const usageRows = store.listLedger(payer.id).filter((entry) => entry.reason === "usage");
    assert.equal(usageRows.length, 1);
    assert.equal(usageRows[0]?.deltaUsd, "-0.000025");
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

  it("does not reserve inflight for an invalid JSON body or an unknown route", async () => {
    const user = store.createUser({ email: "stuck@example.com", name: "Stuck", password: "password1" });
    store.grantUsd(user.id, "1.00");
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
    assert.equal(readInflight(dataDir, user.id), 0);

    const afterBad = await app.inject(chat);
    assert.notEqual(afterBad.statusCode, 402);

    await waitForUser(store, user.id, "0.999975");
    assert.equal(readInflight(dataDir, user.id), 0);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/not-a-route",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      payload: { model: "demo" },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(readInflight(dataDir, user.id), 0);

    const afterMissing = await app.inject(chat);
    assert.notEqual(afterMissing.statusCode, 402);
  });

  it("returns 503 when prices are not ready and does not call the provider", async () => {
    let calls = 0;
    const coldUpstream = await listen((_req, res) => {
      calls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const dir = await mkdtemp(join(tmpdir(), "viate-users-cold-"));
    const coldStore = await AdminStore.open(dir);
    enablePublished(coldStore, { baseUrl: coldUpstream.url, apiKey: "env-key" });
    const user = coldStore.createUser({ email: "cold@example.com", name: "Cold", password: "password1" });
    coldStore.grantUsd(user.id, "1.00");
    const secret = coldStore.createApiKey("cold", user.id).secret;
    const coldApp = await buildApp({
      logger: false,
      pluginManager: emptyPlugins(),
      providers: [billingProvider()],
      store: coldStore,
      adminPassword: "correct-horse",
      adminEnabled: true,
      modelPrices: { ready: false, lookup: () => null },
    });
    try {
      const denied = await coldApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${secret}` },
        payload: { model: "demo", messages: [] },
      });
      assert.equal(denied.statusCode, 503);
      assert.equal(denied.json().error.message, "model prices unavailable");
      assert.equal(calls, 0);
      assert.equal(coldStore.getUser(user.id)?.balanceUsd, "1.00");
      assert.equal(readInflight(dir, user.id), 0);
    } finally {
      await coldApp.close();
      await coldUpstream.close();
      coldStore.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proxies an unbound key when no price catalog is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "viate-users-unbound-"));
    const openStore = await AdminStore.open(dir);
    const openUpstream = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-open", choices: [{ message: { content: "ok" } }] }));
    });
    enablePublished(openStore, { baseUrl: openUpstream.url, apiKey: "env-key" });
    const secret = openStore.createApiKey("plain").secret;
    const openApp = await buildApp({
      logger: false,
      pluginManager: emptyPlugins(),
      providers: [billingProvider()],
      store: openStore,
      adminPassword: null,
      adminEnabled: false,
    });
    try {
      const response = await openApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${secret}` },
        payload: { model: "demo", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().id, "chatcmpl-open");
    } finally {
      await openApp.close();
      await openUpstream.close();
      openStore.close();
      await rm(dir, { recursive: true, force: true });
    }
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

function readBalanceNano(dataDir: string, userId: string): number {
  const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
  try {
    const row = db.prepare("SELECT balance_nano FROM users WHERE id = ?").get(userId) as {
      balance_nano: number | bigint;
    };
    return Number(row.balance_nano);
  } finally {
    db.close();
  }
}

function demoModelPrices() {
  const rate = { inputNanoPerMillion: 1_000_000_000, outputNanoPerMillion: 1_000_000_000 };
  return {
    ready: true,
    lookup(modelId: string) {
      return modelId === "demo" || modelId === "unlisted" ? rate : null;
    },
  };
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

async function waitForUser(store: AdminStore, userId: string, balanceUsd: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (store.getUser(userId)?.balanceUsd === balanceUsd) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(store.getUser(userId)?.balanceUsd, balanceUsd);
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
