import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { PluginOperator } from "./admin.js";
import { buildApp, type App } from "./app.js";
import type { RequestLogRecord } from "./store.js";
import { AdminStore } from "./store.js";

const ORIGIN = "http://localhost:80";
const HOST = "localhost:80";

type Fixture = { app: App; store: AdminStore; dataDir: string };
const open: Fixture[] = [];

async function createFixture(): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "viate-service-"));
  const store = await AdminStore.open(dataDir);
  const app = await buildApp({
    logger: false,
    store,
    adminPassword: "correct-horse",
    adminEnabled: true,
    pluginManager: emptyPlugins(),
    publicUrl: "https://viate.example",
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

describe("service api", { concurrency: false }, () => {
  it("rejects a token whose scope does not include the route", async () => {
    const { app, store } = await createFixture();
    const user = store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const client = await createClient(app, ["users:read", "channels:read", "keys:write", "usage:read"]);
    const narrow = await clientCredentials(app, client, "users:read");
    const users = await service(app, narrow, "GET", "/api/service/users?limit=1");
    assert.equal(users.statusCode, 200);
    assert.equal(users.json().users[0].id, user.id);
    assert.equal("balanceUsd" in users.json().users[0], false);
    const keys = await service(app, narrow, "POST", `/api/service/users/${user.id}/keys`, {
      name: "bot",
      channelId: "missing",
      kind: "bot",
      externalRef: "bot-1",
    });
    assert.equal(keys.statusCode, 403);
    assert.equal(keys.json().error.message, "insufficient scope");
    const portal = await app.inject({
      method: "GET",
      url: "/api/service/users",
      headers: { cookie: "viate_user=nope; viate_oauth=nope" },
    });
    assert.equal(portal.statusCode, 401);
  });

  it("stops one client from listing or deleting keys issued by another", async () => {
    const { app, store } = await createFixture();
    const user = store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const channel = store.createChannel({ name: "Standard", ratio: "1", rule: { kind: "all" } });
    store.setUserChannels(user.id, [channel.id]);
    const first = await createClient(app, ["keys:write"]);
    const second = await createClient(app, ["keys:write"]);
    const firstToken = await clientCredentials(app, first, "keys:write");
    const secondToken = await clientCredentials(app, second, "keys:write");
    const created = await service(app, firstToken, "POST", `/api/service/users/${user.id}/keys`, {
      name: "bot:ada",
      channelId: channel.id,
      kind: "bot",
      externalRef: "bot-ada",
    });
    assert.equal(created.statusCode, 200);
    assert.match(created.json().key, /^viate_/);
    assert.equal(created.json().kind, "bot");
    const models = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${created.json().key}` },
    });
    assert.equal(models.statusCode, 200);
    const own = await service(app, firstToken, "GET", "/api/service/keys?kind=bot");
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().apiKeys.length, 1);
    assert.equal(own.json().apiKeys[0].externalRef, "bot-ada");
    assert.equal("key" in own.json().apiKeys[0], false);
    const other = await service(app, secondToken, "GET", "/api/service/keys?kind=bot");
    assert.equal(other.statusCode, 200);
    assert.deepEqual(other.json().apiKeys, []);
    const removed = await service(app, secondToken, "DELETE", `/api/service/keys/${created.json().id}`);
    assert.equal(removed.statusCode, 404);
    const kept = await service(app, firstToken, "DELETE", `/api/service/keys/${created.json().id}`);
    assert.equal(kept.statusCode, 200);
  });

  it("refuses portal deletion of a managed key until the owning client is removed", async () => {
    const { app, store } = await createFixture();
    const user = store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    const channel = store.createChannel({ name: "Standard", ratio: "1", rule: { kind: "all" } });
    store.setUserChannels(user.id, [channel.id]);
    const client = await createClient(app, ["keys:write"]);
    const token = await clientCredentials(app, client, "keys:write");
    const created = await service(app, token, "POST", `/api/service/users/${user.id}/keys`, {
      name: "bot:ada",
      channelId: channel.id,
      kind: "bot",
      externalRef: "bot-ada",
    });
    const portalSession = await loginPortal(app, user.email, "password1");
    const listed = await portal(app, portalSession, "GET", "/api/portal/keys");
    assert.equal(listed.json().apiKeys[0].kind, "bot");
    assert.equal(listed.json().apiKeys[0].managed, true);
    const denied = await portal(app, portalSession, "DELETE", `/api/portal/keys/${created.json().id}`);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.message, "managed key");
    const admin = await loginAdmin(app);
    const deleted = await authed(app, admin, "DELETE", `/api/admin/oauth-clients/${client.client.id}`);
    assert.equal(deleted.statusCode, 200);
    const after = await portal(app, portalSession, "GET", "/api/portal/keys");
    assert.equal(after.json().apiKeys[0].managed, false);
    assert.equal(store.getOAuthClient(client.client.id), null);
    const removed = await portal(app, portalSession, "DELETE", `/api/portal/keys/${created.json().id}`);
    assert.equal(removed.statusCode, 200);
  });

  it("buckets owned-key usage and prices it from the ledger", async () => {
    const { app, store } = await createFixture();
    const user = store.createUser({ email: "ada@example.com", name: "Ada", password: "password1" });
    store.grantUsd(user.id, "1.00");
    const channel = store.createChannel({ name: "Standard", ratio: "1", rule: { kind: "all" } });
    store.setUserChannels(user.id, [channel.id]);
    const client = await createClient(app, ["keys:write", "usage:read"]);
    const other = await createClient(app, ["keys:write", "usage:read"]);
    const token = await clientCredentials(app, client, "keys:write usage:read");
    const created = await service(app, token, "POST", `/api/service/users/${user.id}/keys`, {
      name: "bot:ada",
      channelId: channel.id,
      kind: "bot",
      externalRef: "bot-ada",
    });
    const foreign = store.createBotApiKey({
      name: "bot:other",
      userId: user.id,
      channelId: channel.id,
      externalRef: "bot-other",
      ownerClientId: other.client.id,
    });
    const requestId = "usage-owned";
    store.insertRequestLog(logRecord(requestId, created.json().id, created.json().prefix, user.id, "2026-11-13T10:15:00.000Z"), []);
    store.settleUsage({
      userId: user.id,
      requestId,
      inputTokens: 1000,
      outputTokens: 0,
      inputNanoPerMillion: 12_345_000_000,
      outputNanoPerMillion: 0,
    });
    store.insertRequestLog(logRecord("usage-outside", created.json().id, created.json().prefix, user.id, "2026-11-12T10:15:00.000Z"), []);
    const usage = await service(
      app,
      token,
      "GET",
      `/api/service/usage?keyIds=${created.json().id},${foreign.id},missing&from=2026-11-13T00:00:00.000Z&to=2026-11-14T00:00:00.000Z&granularity=hour`,
    );
    assert.equal(usage.statusCode, 200);
    assert.deepEqual(usage.json().buckets, [
      {
        keyId: created.json().id,
        bucket: "2026-11-13T10:00:00.000Z",
        requests: 1,
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: "0.012345",
      },
    ]);
    const tooWide = await service(
      app,
      token,
      "GET",
      `/api/service/usage?keyIds=${created.json().id}&from=2026-11-01T00:00:00.000Z&to=2026-11-09T00:00:00.000Z&granularity=day`,
    );
    assert.equal(tooWide.statusCode, 400);
  });
});

function logRecord(id: string, apiKeyId: string, prefix: string, userId: string, startedAt: string): RequestLogRecord {
  return {
    id,
    startedAt,
    endedAt: startedAt,
    durationMs: 10,
    ttfbMs: 1,
    endpoint: "chat.completions",
    stream: false,
    status: 200,
    outcome: "success",
    requestModel: "demo",
    upstreamModel: "demo",
    providerId: null,
    connectionId: null,
    apiKeyId,
    apiKeyPrefix: prefix,
    userId,
    attemptCount: 1,
    inputTokens: 1000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usageSource: "parser",
    error: null,
    payloadPath: null,
    payloadOffset: null,
    payloadTruncated: false,
  };
}

async function createClient(app: App, scopes: string[]) {
  const session = await loginAdmin(app);
  const response = await authed(app, session, "POST", "/api/admin/oauth-clients", {
    name: "Service",
    redirectUris: ["https://app.example/callback"],
    scopes,
  });
  assert.equal(response.statusCode, 200);
  return response.json() as { client: { id: string }; secret: string };
}

async function clientCredentials(app: App, client: { client: { id: string }; secret: string }, scope: string) {
  const basic = Buffer.from(`${encodeURIComponent(client.client.id)}:${encodeURIComponent(client.secret)}`).toString("base64");
  const response = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({ grant_type: "client_credentials", scope }).toString(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().token_type, "Bearer");
  assert.equal("refresh_token" in response.json(), false);
  assert.equal(response.headers["cache-control"], "no-store");
  return response.json().access_token as string;
}

async function service(app: App, token: string, method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
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

async function loginPortal(app: App, email: string, password: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/portal/login",
    headers: originHeaders(),
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response.headers["set-cookie"]), csrf: response.json().csrf as string };
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.map((part) => String(part).split(";")[0]).join("; ");
}

async function authed(app: App, session: Session, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    headers: {
      ...originHeaders(),
      cookie: session.cookie,
      ...(method === "GET" ? {} : { "x-viate-csrf": session.csrf }),
    },
    payload,
  });
}

async function portal(app: App, session: Session, method: "GET" | "POST" | "DELETE", url: string) {
  return authed(app, session, method, url);
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
