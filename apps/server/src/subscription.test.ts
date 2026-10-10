import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { redactSource, type ListedPlugin } from "@viateai/plugin-manager";
import type { ProviderHandler, SubscriptionResult } from "@viateai/sdk";
import type { PluginOperator } from "./admin.js";
import { buildApp, type App } from "./app.js";
import { buildSubscriptionViews, createSubscriptionScheduler, usageLevel } from "./subscription.js";
import { AdminStore } from "./store.js";

const ORIGIN = "http://localhost:80";
const HOST = "localhost:80";

describe("subscription balances", () => {
  let dataDir = "";
  let store: AdminStore;
  let app: App;
  let mode: "cursor" | "replace" | "invalid" | "failed" | "reauth" | "throw" | "levels" = "cursor";
  let calls = 0;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-subscription-"));
    store = await AdminStore.open(dataDir);
    app = await buildApp({
      logger: false,
      pluginManager: new FakePlugins(),
      store,
      adminPassword: "correct-horse",
      adminEnabled: true,
      providers: [cursorProvider(async () => {
        calls += 1;
        if (mode === "throw") {
          throw new Error("bearer super-secret-token rejected");
        }
        return nextResult(mode);
      }), plainProvider()],
    });
  });

  after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("keeps one usage row per type and replaces them on the next success", async () => {
    const session = await login(app);
    const created = store.createConnection("cursor");
    store.putCredentials(created.id, { token: "super-secret-token" }, "Cursor work");
    const listed = await authed(app, session, { method: "GET", url: "/api/admin/subscriptions" });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().subscriptions[0].support, "supported");
    assert.equal(listed.json().subscriptions[0].status, "unknown");
    assert.equal(calls, 0);

    mode = "cursor";
    const refreshed = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${created.id}/subscription/refresh`,
    });
    assert.equal(refreshed.statusCode, 200);
    const subscription = refreshed.json().subscription;
    assert.equal(subscription.plan, "Cursor Pro");
    assert.deepEqual(subscription.usages.map((usage: { type: string }) => usage.type), ["total", "auto_composer", "api"]);
    assert.equal(subscription.usages[1].label, "Auto + Composer");
    assert.equal(subscription.usages[1].currency, "USD");
    assert.equal(JSON.stringify(subscription).includes("super-secret-token"), false);
    assert.equal(store.getConnection(created.id)?.keepaliveStatus, "idle");

    mode = "replace";
    const replaced = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${created.id}/subscription/refresh`,
    });
    assert.deepEqual(replaced.json().subscription.usages.map((usage: { type: string }) => usage.type), ["gemini-3.1-pro"]);

    mode = "invalid";
    const invalid = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${created.id}/subscription/refresh`,
    });
    assert.equal(invalid.statusCode, 200);
    assert.equal(invalid.json().subscription.status, "failed");
    assert.equal(invalid.json().subscription.error, "duplicate usage type");
    assert.deepEqual(store.listSubscriptionUsages().map((usage) => usage.type), ["gemini-3.1-pro"]);

    mode = "throw";
    const thrown = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${created.id}/subscription/refresh`,
    });
    assert.equal(thrown.json().subscription.error, "bearer [redacted] rejected");
    assert.equal(JSON.stringify(thrown.json()).includes("super-secret-token"), false);

    mode = "reauth";
    const reauth = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${created.id}/subscription/refresh`,
    });
    assert.equal(reauth.json().subscription.status, "needs_reauth");
    assert.equal(reauth.json().subscription.stale, true);
    assert.equal(store.getConnection(created.id)?.keepaliveStatus, "idle");
    assert.deepEqual(store.listSubscriptionUsages().map((usage) => usage.type), ["gemini-3.1-pro"]);

    store.deleteConnection(created.id);
    assert.equal(store.listSubscriptionUsages().length, 0);
  });

  it("rates each usage type and refuses refresh when the provider cannot answer", async () => {
    const session = await login(app);
    const created = store.createConnection("cursor");
    store.putCredentials(created.id, { token: "super-secret-token" }, "Gemini");
    mode = "levels";
    const refreshed = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${created.id}/subscription/refresh`,
    });
    const usages = refreshed.json().subscription.usages;
    assert.equal(usages.find((usage: { type: string }) => usage.type === "weekly").level, "low");
    assert.equal(usages.find((usage: { type: string }) => usage.type === "opus").level, "exhausted");
    assert.equal(usages.find((usage: { type: string }) => usage.type === "hidden").level, "unknown");
    assert.equal(refreshed.json().subscription.level, "exhausted");
    const later = buildSubscriptionViews(store, new Map([["cursor", cursorProvider(async () => nextResult("levels"))]]), Date.now() + 120_000);
    assert.equal(later.find((view) => view.connectionId === created.id)?.stale, true);

    const missingCredentials = store.createConnection("cursor");
    const noCredentials = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${missingCredentials.id}/subscription/refresh`,
    });
    assert.equal(noCredentials.statusCode, 400);
    assert.equal(noCredentials.json().error.message, "Save credentials before refreshing subscription");

    const plain = store.createConnection("plain");
    store.putCredentials(plain.id, { token: "k" }, "Plain");
    const unsupported = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${plain.id}/subscription/refresh`,
    });
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.json().error.message, "provider does not support subscription");

    const orphan = store.createConnection("missing");
    store.putCredentials(orphan.id, { token: "k" }, "Missing");
    const missing = await authed(app, session, {
      method: "POST",
      url: `/api/admin/connections/${orphan.id}/subscription/refresh`,
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.message, "Reinstall the plugin before refreshing subscription");

    const plugins = await authed(app, session, { method: "GET", url: "/api/admin/plugins" });
    assert.equal(plugins.json().plugins[0].hasSubscription, true);
    assert.equal(usageLevel({ unit: "percent", used: 10, limit: 100, remaining: 90, unlimited: false, reported: true }), "ok");
  });
});

describe("subscription scheduler", () => {
  it("polls active connections of one provider serially and skips inactive ones", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-subscription-sched-"));
    const store = await AdminStore.open(dataDir);
    const seen: string[] = [];
    const hold = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const saved = Promise.withResolvers<void>();
    let calls = 0;
    let writes = 0;
    const save = store.saveSubscriptionSuccess.bind(store);
    store.saveSubscriptionSuccess = (id, input) => {
      save(id, input);
      writes += 1;
      if (writes === 2) {
        saved.resolve();
      }
    };
    const provider: ProviderHandler = {
      id: "cursor",
      async subscription(input) {
        seen.push(input.connectionId);
        calls += 1;
        if (calls === 1) {
          firstEntered.resolve();
          await hold.promise;
        }
        return okUsage();
      },
    };
    const first = store.createConnection("cursor");
    const second = store.createConnection("cursor");
    const inactive = store.createConnection("cursor");
    store.putCredentials(first.id, { token: "a" }, "One");
    store.putCredentials(second.id, { token: "b" }, "Two");
    store.putCredentials(inactive.id, { token: "c" }, "Three");
    store.setActive(first.id, true);
    store.setActive(second.id, true);
    const scheduler = createSubscriptionScheduler({
      store,
      providers: new Map([["cursor", provider]]),
      log: silentLog(),
      spacingMs: 0,
    });
    scheduler.start();
    await firstEntered.promise;
    assert.equal(calls, 1);
    hold.resolve();
    await saved.promise;
    assert.equal(store.getConnection(inactive.id)?.subscriptionStatus, "unknown");
    assert.equal(store.getConnection(first.id)?.subscriptionStatus, "ok");
    assert.equal(store.getConnection(second.id)?.subscriptionStatus, "ok");
    assert.deepEqual(seen.slice().sort(), [first.id, second.id].sort());
    scheduler.stop();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("coalesces overlapping refreshes for the same connection", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-subscription-coalesce-"));
    const store = await AdminStore.open(dataDir);
    let calls = 0;
    const gate = Promise.withResolvers<void>();
    const provider: ProviderHandler = {
      id: "cursor",
      async subscription() {
        calls += 1;
        await gate.promise;
        return okUsage();
      },
    };
    const connection = store.createConnection("cursor");
    store.putCredentials(connection.id, { token: "a" }, "One");
    const scheduler = createSubscriptionScheduler({
      store,
      providers: new Map([["cursor", provider]]),
      log: silentLog(),
      spacingMs: 0,
    });
    const first = scheduler.refresh(connection.id);
    const second = scheduler.refresh(connection.id);
    gate.resolve();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(left.connectionId, connection.id);
    assert.equal(right.usages[0]?.type, "api");
    scheduler.stop();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

function okUsage(): SubscriptionResult {
  return {
    status: "ok",
    plan: "Cursor Pro",
    usages: [{ type: "api", label: "API", unit: "percent", used: 10, limit: 100, remaining: 90 }],
  };
}

function nextResult(mode: "cursor" | "replace" | "invalid" | "failed" | "reauth" | "levels"): SubscriptionResult {
  if (mode === "failed") {
    return { status: "failed", error: "upstream down" };
  }
  if (mode === "reauth") {
    return { status: "needs_reauth", error: "sign in" };
  }
  if (mode === "invalid") {
    return {
      status: "ok",
      usages: [
        { type: "api", label: "API", unit: "percent", used: 1, limit: 100, remaining: 99 },
        { type: "api", label: "API again", unit: "percent", used: 2, limit: 100, remaining: 98 },
      ],
    };
  }
  if (mode === "replace") {
    return {
      status: "ok",
      plan: "Gemini",
      usages: [{ type: "gemini-3.1-pro", label: "Gemini 3.1 Pro", group: "Models", unit: "percent", used: 20, limit: 100, remaining: 80 }],
    };
  }
  if (mode === "levels") {
    return {
      status: "ok",
      plan: "Gemini",
      nextDueMs: 60_000,
      usages: [
        { type: "weekly", label: "Gemini Models", group: "Weekly", unit: "percent", used: 82, limit: 100, remaining: 18 },
        { type: "opus", label: "claude-opus", group: "Models", unit: "percent", used: 100, limit: 100, remaining: 0 },
        { type: "hidden", label: "Hidden", group: "Models", unit: "percent", used: 0, limit: 100, remaining: 100, reported: false },
      ],
    };
  }
  return {
    status: "ok",
    plan: "Cursor Pro",
    usages: [
      { type: "total", label: "Total", group: "Plan", unit: "currency", currency: "USD", used: 18.2, limit: 20, remaining: 1.8 },
      { type: "auto_composer", label: "Auto + Composer", group: "Plan", unit: "currency", currency: "USD", used: 12.4, limit: 20, remaining: 7.6 },
      { type: "api", label: "API", group: "Plan", unit: "currency", currency: "USD", used: 5.8, limit: 20, remaining: 14.2 },
    ],
  };
}

function cursorProvider(subscription: ProviderHandler["subscription"]): ProviderHandler {
  return { id: "cursor", subscription };
}

function plainProvider(): ProviderHandler {
  return { id: "plain" };
}

function silentLog(): FastifyBaseLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as FastifyBaseLogger;
}

class FakePlugins implements PluginOperator {
  async list(): Promise<ListedPlugin[]> {
    return [{
      name: "@viateai/plugin-cursor",
      version: "1.0.0",
      source: redactSource("file:cursor"),
      id: "cursor",
      status: "active" as const,
    }];
  }

  async add(): Promise<ListedPlugin[]> {
    throw new Error("not used");
  }

  async update(): Promise<ListedPlugin[]> {
    throw new Error("not used");
  }

  async remove(): Promise<ListedPlugin[]> {
    throw new Error("not used");
  }
}

type Session = { cookie: string; csrf: string };

async function login(app: App): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { host: HOST, origin: ORIGIN },
    payload: { password: "correct-horse" },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return {
    cookie: cookies.map((part) => String(part).split(";")[0]).join("; "),
    csrf: response.json().csrf as string,
  };
}

async function authed(
  app: App,
  session: Session,
  options: { method: "GET" | "POST"; url: string },
) {
  return app.inject({
    method: options.method,
    url: options.url,
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: session.cookie,
      ...(options.method === "GET" ? {} : { "x-viate-csrf": session.csrf }),
    },
  });
}
