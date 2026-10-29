import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { redactSource, type ListedPlugin } from "@viateai/plugin-manager";
import type { ProviderHandler } from "@viateai/sdk";
import type { PluginOperator } from "./admin.js";
import { buildApp, type App } from "./app.js";
import { AdminStore } from "./store.js";

const ORIGIN = "http://localhost:80";
const HOST = "localhost:80";

describe("admin API", () => {
  let dataDir = "";
  let store: AdminStore;
  let plugins: FakePlugins;
  let app: App;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-admin-"));
    store = await AdminStore.open(dataDir);
    plugins = new FakePlugins();
    app = await buildApp({
      logger: false,
      pluginManager: plugins,
      store,
      adminPassword: "correct-horse",
      adminEnabled: true,
      pluginFailures: [{ name: "@viate/broken", error: "register exploded" }],
      providers: [testProvider()],
    });
  });

  after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated management reads and mutations", async () => {
    const listed = await app.inject({ method: "GET", url: "/api/admin/plugins" });
    assert.equal(listed.statusCode, 401);

    const install = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: originHeaders(),
      payload: { source: "./plugin.tgz" },
    });
    assert.equal(install.statusCode, 401);
  });

  it("rejects cross-origin login and requires the admin password", async () => {
    const cross = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { host: HOST, origin: "http://evil.example" },
      payload: { password: "correct-horse" },
    });
    assert.equal(cross.statusCode, 403);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: originHeaders(),
      payload: { password: "nope" },
    });
    assert.equal(wrong.statusCode, 401);
  });

  it("issues a session, rejects CSRF-less mutations, and revokes on logout", async () => {
    const session = await login(app, "correct-horse");

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: {
        ...originHeaders(),
        cookie: session.cookie,
      },
      payload: { source: "./plugin.tgz" },
    });
    assert.equal(noCsrf.statusCode, 403);

    const badOrigin = await app.inject({
      method: "POST",
      url: "/api/admin/plugins/install",
      headers: {
        host: HOST,
        origin: "http://evil.example",
        cookie: session.cookie,
        "x-viate-csrf": session.csrf,
      },
      payload: { source: "./plugin.tgz" },
    });
    assert.equal(badOrigin.statusCode, 403);

    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/session",
      headers: { cookie: session.cookie },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().authenticated, true);

    const logout = await app.inject({
      method: "POST",
      url: "/api/admin/logout",
      headers: {
        ...originHeaders(),
        cookie: session.cookie,
        "x-viate-csrf": session.csrf,
      },
    });
    assert.equal(logout.statusCode, 200);

    const after = await app.inject({
      method: "GET",
      url: "/api/admin/plugins",
      headers: { cookie: session.cookie },
    });
    assert.equal(after.statusCode, 401);
  });

  it("records successful and failed plugin operations without raw installer secrets", async () => {
    const session = await login(app, "correct-horse");
    plugins.plugins = [
      {
        name: "@viate/broken",
        version: "1.0.0",
        source: "https://user:ghp_secret@github.com/org/broken.git?token=abc",
        id: "broken",
        status: "active",
      },
    ];
    plugins.failNext = new Error(
      "pnpm add failed (1): https://user:ghp_secret@github.com/org/plugin.git?token=abc boom",
    );

    const failed = await authed(app, session, {
      method: "POST",
      url: "/api/admin/plugins/install",
      payload: { source: "https://user:ghp_secret@github.com/org/plugin.git?token=abc" },
    });
    assert.equal(failed.statusCode, 200);
    const failedBody = failed.json() as {
      log: { status: string; message: string; source: string; restartRequired: boolean };
      plugins: Array<{ source: string; error: string | null; restartRequired: boolean }>;
    };
    assert.equal(failedBody.log.status, "failure");
    assert.equal(failedBody.log.restartRequired, false);
    assert.doesNotMatch(failedBody.log.message, /ghp_secret|token=abc|user:ghp/);
    assert.equal(failedBody.log.source, "https://github.com/org/plugin.git");
    assert.equal(failedBody.plugins[0]?.error, "register exploded");
    assert.equal(failedBody.plugins[0]?.source, "https://github.com/org/broken.git");

    const installed = await authed(app, session, {
      method: "POST",
      url: "/api/admin/plugins/install",
      payload: { source: "/tmp/official.tgz" },
    });
    assert.equal(installed.statusCode, 200);
    const installedBody = installed.json() as {
      log: { status: string; restartRequired: boolean; message: string };
      plugins: Array<{ name: string; status: string; restartRequired: boolean; source: string }>;
    };
    assert.equal(installedBody.log.status, "success");
    assert.equal(installedBody.log.restartRequired, true);
    assert.match(installedBody.log.message, /restart required/);
    assert.equal(installedBody.plugins.at(-1)?.status, "pending");
    assert.equal(installedBody.plugins.at(-1)?.restartRequired, true);

    const logs = await authed(app, session, { method: "GET", url: "/api/admin/logs" });
    const logList = logs.json().logs as Array<{ status: string; message: string; source: string | null }>;
    assert.ok(logList.some((entry) => entry.status === "success"));
    assert.ok(logList.some((entry) => entry.status === "failure"));
    for (const entry of logList) {
      assert.doesNotMatch(entry.message, /ghp_secret|token=abc/);
      if (entry.source) {
        assert.doesNotMatch(entry.source, /ghp_secret|token=abc/);
      }
    }
  });

  it("lists request logs and returns payload only on detail", async () => {
    const session = await login(app, "correct-horse");
    store.insertRequestLog(
      {
        id: "req-admin-1",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 12,
        ttfbMs: 3,
        endpoint: "chat.completions",
        stream: false,
        status: 200,
        outcome: "success",
        requestModel: "demo",
        upstreamModel: "demo",
        providerId: "openai-compatible",
        connectionId: "conn-1",
        apiKeyId: "key-1",
        apiKeyPrefix: "viate_abc",
        attemptCount: 1,
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        usageSource: "parser",
        error: null,
        payloadPath: null,
        payloadOffset: null,
        payloadTruncated: false,
      },
      [
        {
          seq: 1,
          providerId: "openai-compatible",
          connectionId: "conn-1",
          upstreamModel: "demo",
          status: 200,
          durationMs: 12,
          error: null,
        },
      ],
    );

    const listed = await authed(app, session, { method: "GET", url: "/api/admin/requests" });
    assert.equal(listed.statusCode, 200);
    const rows = listed.json().requests as Array<{ id: string; request?: unknown }>;
    assert.equal(rows[0]?.id, "req-admin-1");
    assert.equal("request" in (rows[0] ?? {}), false);

    const detail = await authed(app, session, { method: "GET", url: "/api/admin/requests/req-admin-1" });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().request.id, "req-admin-1");
    assert.equal(detail.json().attempts[0]?.connectionId, "conn-1");

    const stats = await authed(app, session, { method: "GET", url: "/api/admin/requests/stats?window=1h" });
    assert.equal(stats.statusCode, 200);
    assert.equal(typeof stats.json().stats.qps, "number");
  });

  it("filters request stats, rejects a bad outcome, and keeps list bodies off the page", async () => {
    const session = await login(app, "correct-horse");
    const marker = "payload-marker-should-not-list";
    await mkdir(join(dataDir, "request-logs"), { recursive: true });
    await writeFile(
      join(dataDir, "request-logs", "marker.jsonl"),
      `${JSON.stringify({
        id: "req-http-stream",
        request: { marker },
        response: { status: 200, body: { marker } },
      })}\n`,
    );
    store.insertRequestLog(
      {
        id: "req-http-stream",
        startedAt: "2026-08-01T00:10:00.000Z",
        endedAt: "2026-08-01T00:10:02.000Z",
        durationMs: 2000,
        ttfbMs: 180,
        endpoint: "chat.completions",
        stream: true,
        status: 200,
        outcome: "success",
        requestModel: "http-alpha",
        upstreamModel: "http-alpha",
        providerId: "prov-a",
        connectionId: "conn-a",
        apiKeyId: "key-a",
        apiKeyPrefix: "viate_aaa",
        attemptCount: 1,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        usageSource: "parser",
        error: null,
        payloadPath: "request-logs/marker.jsonl",
        payloadOffset: 0,
        payloadTruncated: false,
      },
      [],
    );
    store.insertRequestLog(
      {
        id: "req-http-error",
        startedAt: "2026-08-01T00:20:00.000Z",
        endedAt: "2026-08-01T00:20:00.500Z",
        durationMs: 500,
        ttfbMs: null,
        endpoint: "embeddings",
        stream: false,
        status: 502,
        outcome: "upstream_error",
        requestModel: "http-beta",
        upstreamModel: "http-beta",
        providerId: "prov-b",
        connectionId: "conn-b",
        apiKeyId: "key-b",
        apiKeyPrefix: "viate_bbb",
        attemptCount: 1,
        inputTokens: 2,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usageSource: "missing",
        error: "upstream failed",
        payloadPath: null,
        payloadOffset: null,
        payloadTruncated: false,
      },
      [],
    );

    const range = "from=2026-08-01T00:00:00.000Z&to=2026-08-01T01:00:00.000Z";
    const filtered = await authed(app, session, { method: "GET", url: `/api/admin/requests/stats?${range}` });
    assert.equal(filtered.statusCode, 200);
    const stats = filtered.json().stats as {
      from: string;
      to: string;
      requests: number;
      errors: number;
      errorRate: number;
      rpm: number;
      outputTps: number;
      series: Array<{ t: string }>;
      byModel: Array<{ model: string }>;
      byConnection: Array<{ connectionId: string }>;
      qps?: number;
    };
    assert.equal(stats.from, "2026-08-01T00:00:00.000Z");
    assert.equal(stats.to, "2026-08-01T01:00:00.000Z");
    assert.equal(stats.requests, 2);
    assert.equal(stats.errors, 1);
    assert.equal(stats.errorRate, 0.5);
    assert.equal(stats.rpm, 2 / 60);
    assert.equal(stats.outputTps, 4 / (2500 / 1000));
    assert.equal(stats.series[0]?.t, "2026-08-01T00:10:00.000Z");
    assert.equal(stats.byModel.length, 2);
    assert.equal(stats.byConnection.length, 2);
    assert.equal(stats.qps, undefined);

    const narrowed = await authed(app, session, {
      method: "GET",
      url: `/api/admin/requests/stats?${range}&model=http-alpha`,
    });
    assert.equal(narrowed.json().stats.requests, 1);

    const listed = await authed(app, session, { method: "GET", url: "/api/admin/requests?model=http-alpha" });
    assert.equal(listed.statusCode, 200);
    const body = listed.json() as { requests: Array<Record<string, unknown>>; nextBefore?: string };
    assert.equal(body.requests[0]?.id, "req-http-stream");
    assert.equal("request" in (body.requests[0] ?? {}), false);
    assert.equal("response" in (body.requests[0] ?? {}), false);
    assert.equal(JSON.stringify(body).includes(marker), false);
    assert.equal(body.nextBefore, undefined);

    const detail = await authed(app, session, { method: "GET", url: "/api/admin/requests/req-http-stream" });
    assert.equal(detail.statusCode, 200);
    assert.equal(JSON.stringify(detail.json()).includes(marker), true);

    const bad = await authed(app, session, { method: "GET", url: "/api/admin/requests?outcome=nope" });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error.message, /invalid outcome/);

    const windowed = await authed(app, session, { method: "GET", url: "/api/admin/requests/stats?window=1h" });
    assert.equal(windowed.statusCode, 200);
    assert.equal(typeof windowed.json().stats.qps, "number");
    assert.equal(windowed.json().stats.from, undefined);
  });

  it("matches list bounds after canonicalizing non-millisecond timestamps", async () => {
    const session = await login(app, "correct-horse");
    store.insertRequestLog(
      {
        id: "req-bound-exact",
        startedAt: "2026-08-01T00:00:00.000Z",
        endedAt: "2026-08-01T00:00:00.000Z",
        durationMs: 1,
        ttfbMs: null,
        endpoint: "chat.completions",
        stream: false,
        status: 200,
        outcome: "success",
        requestModel: "bound-model",
        upstreamModel: null,
        providerId: "prov",
        connectionId: "conn",
        apiKeyId: null,
        apiKeyPrefix: null,
        attemptCount: 0,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usageSource: "missing",
        error: null,
        payloadPath: null,
        payloadOffset: null,
        payloadTruncated: false,
      },
      [],
    );

    const listed = await authed(app, session, {
      method: "GET",
      url: "/api/admin/requests?from=2026-08-01T00:00:00Z&to=2026-08-01T00:00:00Z",
    });
    assert.equal(listed.statusCode, 200);
    const ids = (listed.json().requests as Array<{ id: string }>).map((row) => row.id);
    assert.equal(ids.includes("req-bound-exact"), true);

    const reversed = await authed(app, session, {
      method: "GET",
      url: "/api/admin/requests?from=2026-08-02T00:00:00.000Z&to=2026-08-01T00:00:00.000Z",
    });
    assert.equal(reversed.statusCode, 400);

    const endpoint = await authed(app, session, {
      method: "GET",
      url: "/api/admin/requests?endpoint=not-an-endpoint",
    });
    assert.equal(endpoint.statusCode, 400);
  });

  it("creates empty connections, delegates credentials, and activates explicitly", async () => {
    const session = await login(app, "correct-horse");
    const created = await authed(app, session, {
      method: "POST",
      url: "/api/admin/connections",
      payload: { providerId: "openai-compatible" },
    });
    assert.equal(created.statusCode, 200);
    const connection = created.json().connection as { id: string; hasCredentials: boolean; active: boolean };
    assert.equal(connection.hasCredentials, false);
    assert.equal(connection.active, false);

    const configured = await authed(app, session, {
      method: "PUT",
      url: `/api/admin/connections/${connection.id}`,
      payload: { credentials: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "super-secret-key" } },
    });
    assert.equal(configured.statusCode, 200);
    assert.equal(configured.json().connection.hasCredentials, true);
    assert.equal(configured.json().connection.displayLabel, "127.0.0.1:9999");
    assert.equal(JSON.stringify(configured.json()).includes("super-secret-key"), false);

    const activated = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${connection.id}/activate`,
    });
    assert.equal(activated.statusCode, 200);
    assert.equal(activated.json().connection.active, true);

    const listed = await authed(app, session, { method: "GET", url: "/api/admin/connections" });
    assert.equal(listed.json().connections[0].hasCredentials, true);
    assert.equal(JSON.stringify(listed.json()).includes("super-secret-key"), false);
  });

  it("activates a connection from a browser empty POST", async () => {
    const session = await login(app, "correct-horse");
    const created = await authed(app, session, {
      method: "POST",
      url: "/api/admin/connections",
      payload: { providerId: "openai-compatible" },
    });
    const id = created.json().connection.id as string;
    await authed(app, session, {
      method: "PUT",
      url: `/api/admin/connections/${id}`,
      payload: { credentials: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k" } },
    });
    const activated = await app.inject({
      method: "POST",
      url: `/api/admin/connections/${id}/activate`,
      headers: {
        ...originHeaders(),
        cookie: session.cookie,
        "x-viate-csrf": session.csrf,
        "content-type": "text/plain;charset=UTF-8",
        "content-length": "0",
      },
    });
    assert.equal(activated.statusCode, 200);
    assert.equal(activated.json().connection.active, true);
  });

  it("returns loaded handler metadata and preserves orphan connections", async () => {
    const session = await login(app, "correct-horse");
    plugins.plugins = [{
      name: "@viateai/plugin-openai-compatible",
      version: "1.0.0",
      source: "npm:@viateai/plugin-openai-compatible",
      id: "openai-compatible",
      status: "active",
    }];
    const listed = await authed(app, session, { method: "GET", url: "/api/admin/plugins" });
    const plugin = listed.json().plugins[0];
    assert.deepEqual(plugin.capabilities, ["chatCompletions", "listModels", "embeddings", "responses"]);
    assert.equal(plugin.credentialsForm.length, 2);
    assert.equal(plugin.hasParseCredentials, true);
    assert.equal(plugin.hasOAuth, true);
    assert.equal(plugin.hasKeepalive, true);
    assert.equal(plugin.hasSubscription, false);
    assert.deepEqual(plugin.advertisedEndpointTypes, ["openai", "openai-response"]);

    const orphan = store.createConnection("uninstalled");
    assert.equal(store.getConnection(orphan.id)?.providerId, "uninstalled");
  });

  it("supports paste credentials and OAuth callback without an admin cookie", async () => {
    const session = await login(app, "correct-horse");
    const created = await authed(app, session, {
      method: "POST",
      url: "/api/admin/connections",
      payload: { providerId: "openai-compatible" },
    });
    const id = created.json().connection.id as string;
    const pasted = await authed(app, session, {
      method: "PUT",
      url: `/api/admin/connections/${id}`,
      payload: { text: '{"baseUrl":"https://paste.example/v1","apiKey":"pasted"}' },
    });
    assert.equal(pasted.statusCode, 200);
    assert.equal(pasted.json().connection.displayLabel, "paste.example");

    const started = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${id}/oauth/start`,
    });
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().session, undefined);
    const callbackUrl = new URL(started.json().authorizationUrl as string);
    const state = callbackUrl.searchParams.get("state");
    const callback = await app.inject({
      method: "GET",
      url: `/api/admin/oauth/callback?state=${encodeURIComponent(state ?? "")}&code=oauth-code`,
    });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, "/admin/");
    assert.equal(store.getConnection(id)?.displayLabel, "oauth.example");
  });

  it("lists client API key prefixes, revokes them, and does not issue keys", async () => {
    const session = await login(app, "correct-horse");
    const created = store.createApiKey("codex");
    assert.match(created.secret, /^viate_/);

    const listed = await authed(app, session, { method: "GET", url: "/api/admin/api-keys" });
    assert.equal(listed.statusCode, 200);
    const keys = listed.json().apiKeys as Array<{ id: string; prefix: string }>;
    assert.equal(keys.length, 1);
    assert.equal(keys[0]?.id, created.apiKey.id);
    assert.equal(keys[0]?.prefix, created.apiKey.prefix);
    assert.equal(JSON.stringify(listed.json()).includes(created.secret), false);

    const issued = await authed(app, session, {
      method: "POST",
      url: "/api/admin/api-keys",
      payload: { name: "codex" },
    });
    assert.equal(issued.statusCode, 404);

    const revoked = await authed(app, session, {
      method: "DELETE",
      url: `/api/admin/api-keys/${created.apiKey.id}`,
    });
    assert.equal(revoked.statusCode, 200);

    const after = await authed(app, session, { method: "GET", url: "/api/admin/api-keys" });
    assert.equal(after.json().apiKeys.length, 0);
  });
});

describe("admin disabled without password", () => {
  it("returns 503 for management routes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-admin-off-"));
    const store = await AdminStore.open(dataDir);
    const app = await buildApp({
      logger: false,
      pluginManager: new FakePlugins(),
      store,
      adminPassword: null,
      adminEnabled: false,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        headers: originHeaders(),
        payload: { password: "x" },
      });
      assert.equal(response.statusCode, 503);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("admin connection models", () => {
  let dataDir = "";
  let store: AdminStore;
  let plugins: FakePlugins;
  let app: App;
  const listed = [
    { id: "gpt-4o", object: "model", owned_by: "openai" },
    { id: "gpt-4o-mini", object: "model" },
  ];

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-admin-models-"));
    store = await AdminStore.open(dataDir);
    plugins = new FakePlugins();
    app = await buildApp({
      logger: false,
      pluginManager: plugins,
      store,
      adminPassword: "correct-horse",
      adminEnabled: true,
      providers: [testProvider(listed)],
    });
  });

  after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("syncs, lists, and disables models for a connection", async () => {
    const session = await login(app, "correct-horse");
    const created = await authed(app, session, {
      method: "POST",
      url: "/api/admin/connections",
      payload: { providerId: "openai-compatible" },
    });
    const id = created.json().connection.id as string;
    await authed(app, session, {
      method: "PUT",
      url: `/api/admin/connections/${id}`,
      payload: { credentials: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k" } },
    });

    const empty = await authed(app, session, { method: "GET", url: `/api/admin/connections/${id}/models` });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { connectionId: id, syncedAt: null, models: [] });

    const synced = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${id}/models/sync`,
    });
    assert.equal(synced.statusCode, 200);
    const catalog = synced.json() as {
      connectionId: string;
      syncedAt: string;
      models: Array<{ id: string; name: string; enabled: boolean }>;
    };
    assert.equal(catalog.connectionId, id);
    assert.equal(catalog.syncedAt.length > 0, true);
    assert.deepEqual(
      catalog.models.map((model) => ({ id: model.id, name: model.name, enabled: model.enabled })),
      [
        { id: "gpt-4o", name: "gpt-4o", enabled: true },
        { id: "gpt-4o-mini", name: "gpt-4o-mini", enabled: true },
      ],
    );

    const disabled = await authed(app, session, {
      method: "PUT",
      url: `/api/admin/connections/${id}/models/gpt-4o-mini`,
      payload: { enabled: false },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().models.find((model: { id: string }) => model.id === "gpt-4o-mini")?.enabled, false);

    const listedCatalog = await authed(app, session, { method: "GET", url: `/api/admin/connections/${id}/models` });
    assert.equal(listedCatalog.json().models.find((model: { id: string }) => model.id === "gpt-4o-mini")?.enabled, false);
  });

  it("adds and removes custom models with the same auth as other model routes", async () => {
    const session = await login(app, "correct-horse");
    const created = await authed(app, session, {
      method: "POST",
      url: "/api/admin/connections",
      payload: { providerId: "openai-compatible" },
    });
    const id = created.json().connection.id as string;
    await authed(app, session, {
      method: "PUT",
      url: `/api/admin/connections/${id}`,
      payload: { credentials: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k" } },
    });

    const unauth = await app.inject({
      method: "POST",
      url: `/api/admin/connections/${id}/models`,
      headers: originHeaders(),
      payload: { id: "custom-1" },
    });
    assert.equal(unauth.statusCode, 401);

    const noCsrf = await app.inject({
      method: "POST",
      url: `/api/admin/connections/${id}/models`,
      headers: { ...originHeaders(), cookie: session.cookie },
      payload: { id: "custom-1" },
    });
    assert.equal(noCsrf.statusCode, 403);

    const badOrigin = await app.inject({
      method: "POST",
      url: `/api/admin/connections/${id}/models`,
      headers: {
        host: HOST,
        origin: "http://evil.example",
        cookie: session.cookie,
        "x-viate-csrf": session.csrf,
      },
      payload: { id: "custom-1" },
    });
    assert.equal(badOrigin.statusCode, 403);

    const empty = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${id}/models`,
      payload: { id: "  " },
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error.message, "model id is required");

    const missingConnection = await authed(app, session, {
      method: "POST",
      url: "/api/admin/connections/missing/models",
      payload: { id: "custom-1" },
    });
    assert.equal(missingConnection.statusCode, 404);

    const added = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${id}/models`,
      payload: { id: " grok-voice-transcribe-2.0 ", name: " Voice " },
    });
    assert.equal(added.statusCode, 200);
    const custom = added.json().models.find((model: { id: string }) => model.id === "grok-voice-transcribe-2.0");
    assert.equal(custom?.name, "Voice");
    assert.equal(custom?.enabled, true);
    assert.equal(custom?.custom, true);

    const unnamed = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${id}/models`,
      payload: { id: "plain" },
    });
    assert.equal(unnamed.json().models.find((model: { id: string }) => model.id === "plain")?.name, "plain");

    const duplicate = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${id}/models`,
      payload: { id: "plain" },
    });
    assert.equal(duplicate.statusCode, 409);

    const synced = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${id}/models/sync`,
    });
    assert.equal(synced.statusCode, 200);
    assert.equal(synced.json().models.find((model: { id: string }) => model.id === "gpt-4o")?.custom, false);
    assert.equal(synced.json().models.find((model: { id: string }) => model.id === "plain")?.custom, true);

    const syncedDelete = await authed(app, session, {
      method: "DELETE",
      url: `/api/admin/connections/${id}/models/gpt-4o`,
    });
    assert.equal(syncedDelete.statusCode, 400);

    const missingModel = await authed(app, session, {
      method: "DELETE",
      url: `/api/admin/connections/${id}/models/missing-model`,
    });
    assert.equal(missingModel.statusCode, 404);

    const unauthDelete = await app.inject({
      method: "DELETE",
      url: `/api/admin/connections/${id}/models/${encodeURIComponent("grok-voice-transcribe-2.0")}`,
      headers: originHeaders(),
    });
    assert.equal(unauthDelete.statusCode, 401);

    const noCsrfDelete = await app.inject({
      method: "DELETE",
      url: `/api/admin/connections/${id}/models/${encodeURIComponent("grok-voice-transcribe-2.0")}`,
      headers: { ...originHeaders(), cookie: session.cookie },
    });
    assert.equal(noCsrfDelete.statusCode, 403);

    const removed = await authed(app, session, {
      method: "DELETE",
      url: `/api/admin/connections/${id}/models/${encodeURIComponent("grok-voice-transcribe-2.0")}`,
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().models.some((model: { id: string }) => model.id === "grok-voice-transcribe-2.0"), false);
    assert.equal(removed.json().models.find((model: { id: string }) => model.id === "plain")?.custom, true);
  });

  it("lists published models and reorders contributing providers", async () => {
    const session = await login(app, "correct-horse");
    const openai = await authed(app, session, {
      method: "POST",
      url: "/api/admin/connections",
      payload: { providerId: "openai-compatible" },
    });
    const openaiId = openai.json().connection.id as string;
    await authed(app, session, {
      method: "PUT",
      url: `/api/admin/connections/${openaiId}`,
      payload: { credentials: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k" } },
    });
    await authed(app, session, { method: "POST", url: `/api/admin/connections/${openaiId}/models/sync` });
    await authed(app, session, { method: "POST", url: `/api/admin/connections/${openaiId}/activate` });

    const listed = await authed(app, session, { method: "GET", url: "/api/admin/published-models" });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().models[0]?.publicId, "gpt-4o");
    assert.equal(listed.json().models[0]?.providers[0]?.providerId, "openai-compatible");

    const invalid = await authed(app, session, {
      method: "PUT",
      url: "/api/admin/published-models/gpt-4o/providers",
      payload: { providerIds: ["anthropic"] },
    });
    assert.equal(invalid.statusCode, 400);
  });

  it("rejects sync without credentials or listModels", async () => {
    const session = await login(app, "correct-horse");
    const created = await authed(app, session, {
      method: "POST",
      url: "/api/admin/connections",
      payload: { providerId: "openai-compatible" },
    });
    const id = created.json().connection.id as string;
    const missing = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${id}/models/sync`,
    });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error.message, /no credentials/);
  });

  it("updates advertised endpoint types for a loaded provider", async () => {
    const session = await login(app, "correct-horse");
    plugins.plugins = [{
      name: "@viateai/plugin-openai-compatible",
      version: "1.0.0",
      source: "npm:@viateai/plugin-openai-compatible",
      id: "openai-compatible",
      status: "active",
    }];
    const created = await authed(app, session, {
      method: "POST",
      url: "/api/admin/connections",
      payload: { providerId: "openai-compatible" },
    });
    const id = created.json().connection.id as string;
    await authed(app, session, {
      method: "PUT",
      url: `/api/admin/connections/${id}`,
      payload: { credentials: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k" } },
    });
    await authed(app, session, { method: "POST", url: `/api/admin/connections/${id}/models/sync` });
    await authed(app, session, { method: "POST", url: `/api/admin/connections/${id}/activate` });

    const updated = await authed(app, session, {
      method: "PUT",
      url: "/api/admin/providers/openai-compatible/advertised-endpoints",
      payload: { advertisedEndpointTypes: ["openai-response"] },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().plugins[0]?.advertisedEndpointTypes, ["openai-response"]);

    const models = await authed(app, session, { method: "GET", url: "/api/admin/published-models" });
    assert.equal(models.statusCode, 200);
    const catalog = store.listPublicCatalog().data[0];
    assert.deepEqual(catalog?.supported_endpoint_types, ["openai-response"]);

    const withAudio = await authed(app, session, {
      method: "PUT",
      url: "/api/admin/providers/openai-compatible/advertised-endpoints",
      payload: { advertisedEndpointTypes: ["openai-audio", "openai"] },
    });
    assert.equal(withAudio.statusCode, 200);
    assert.deepEqual(withAudio.json().plugins[0]?.advertisedEndpointTypes, ["openai", "openai-audio"]);
    assert.deepEqual(store.listPublicCatalog().data[0]?.supported_endpoint_types, ["openai", "openai-audio"]);

    const empty = await authed(app, session, {
      method: "PUT",
      url: "/api/admin/providers/openai-compatible/advertised-endpoints",
      payload: { advertisedEndpointTypes: ["anthropic"] },
    });
    assert.equal(empty.statusCode, 400);
  });
});

class FakePlugins implements PluginOperator {
  plugins: ListedPlugin[] = [];
  failNext: Error | null = null;

  async list(): Promise<ListedPlugin[]> {
    return this.plugins.map((plugin) => ({ ...plugin, source: redactSource(plugin.source) }));
  }

  async add(source: string): Promise<ListedPlugin[]> {
    if (source.startsWith("-")) {
      throw new Error('source must not start with "-"');
    }
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.plugins = [
      ...this.plugins.filter((plugin) => plugin.name !== "@viate/official"),
      {
        name: "@viate/official",
        version: "1.2.3",
        source: redactSource(source),
        id: "official",
        status: "pending",
      },
    ];
    return this.list();
  }

  async update(name: string): Promise<ListedPlugin[]> {
    if (name.startsWith("-")) {
      throw new Error('name must not start with "-"');
    }
    this.plugins = this.plugins.map((plugin) =>
      plugin.name === name ? { ...plugin, status: "pending" } : plugin,
    );
    return this.list();
  }

  async remove(name: string): Promise<ListedPlugin[]> {
    if (name.startsWith("-")) {
      throw new Error('name must not start with "-"');
    }
    this.plugins = this.plugins.filter((plugin) => plugin.name !== name);
    return this.list();
  }
}

function testProvider(models?: Array<Record<string, unknown>>): ProviderHandler {
  return {
    id: "openai-compatible",
    credentialsForm: [
      { key: "baseUrl", label: "Base URL", kind: "url", required: true },
      { key: "apiKey", label: "API Key", kind: "secret" },
    ],
    parseCredentials(text) {
      return JSON.parse(text) as unknown;
    },
    normalizeCredentials(input) {
      const credentials = input as { baseUrl: string; apiKey?: string };
      return { credentials, displayLabel: new URL(credentials.baseUrl).host };
    },
    startOAuth(ctx) {
      return Promise.resolve({
        type: "authorization_url",
        authorizationUrl: ctx.callbackUrl,
        session: { verifier: "secret" },
      });
    },
    exchangeOAuth(input) {
      assert.equal((input.session as { verifier: string }).verifier, "secret");
      return Promise.resolve({
        credentials: { token: input.code },
        displayLabel: "oauth.example",
      });
    },
    async keepalive() {
      return { status: "ok" };
    },
    async chatCompletions() {
      return { status: 200, headers: {}, body: null };
    },
    async listModels() {
      return {
        object: "list" as const,
        data: (models ?? []).map((model) => ({
          id: String(model.id),
          object: "model" as const,
          ...(typeof model.name === "string" ? { name: model.name } : {}),
        })),
      };
    },
    async embeddings() {
      return { status: 200, headers: {}, body: null };
    },
    async responses() {
      return { status: 200, headers: {}, body: null };
    },
  };
}

type Session = { cookie: string; csrf: string };

async function login(app: App, password: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: originHeaders(),
    payload: { password },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookies.map((part) => String(part).split(";")[0]).join("; ");
  assert.match(cookie, /viate_admin=/);
  assert.match(cookies.join("\n"), /HttpOnly/i);
  assert.match(cookies.join("\n"), /SameSite=Strict/i);
  return { cookie, csrf: response.json().csrf as string };
}

async function authed(
  app: App,
  session: Session,
  options: { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; payload?: Record<string, unknown> },
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

function originHeaders(): Record<string, string> {
  return { host: HOST, origin: ORIGIN };
}
