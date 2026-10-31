import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { parseOpenAIChatUsage, type ProviderHandler } from "@viateai/sdk";
import { formatChannelRatio, legacyMatchModelIds, parseChannelRatio, parseChannelRule } from "./channels.js";
import { buildApp, type App } from "./app.js";
import { resetRoutingStateForTests } from "./routing.js";
import { AdminStore } from "./store.js";

describe("channel ratio", () => {
  it("stores 0.1 and 7 as exact fractions", () => {
    assert.deepEqual(parseChannelRatio("0.1"), { numerator: 1, denominator: 10 });
    assert.deepEqual(parseChannelRatio("7"), { numerator: 7, denominator: 1 });
    assert.equal(formatChannelRatio(1, 10), "0.1");
    assert.equal(formatChannelRatio(7, 1), "7");
    assert.throws(() => parseChannelRatio("0"), (error: unknown) => error instanceof Error && error.message === "ratio is invalid");
  });

  it("keeps an explicit model list and rejects a prefix rule", () => {
    assert.deepEqual(parseChannelRule({ kind: "models", providerId: "xai", modelIds: ["grok-4", "grok-4"] }), {
      kind: "models",
      modelIds: ["grok-4"],
    });
    assert.throws(
      () => parseChannelRule({ kind: "match", providerId: "xai", prefix: "grok-" }),
      (error: unknown) => error instanceof Error && error.message === "rule is invalid",
    );
    assert.throws(
      () => parseChannelRule({ kind: "models", providerId: null, modelIds: [] }),
      (error: unknown) => error instanceof Error && error.message === "rule is empty",
    );
  });

  it("freezes a prefix rule to the chat models it covered", () => {
    assert.deepEqual(
      legacyMatchModelIds(
        {
          kind: "match",
          providerId: "xai",
          prefix: "grok-",
          excludePrefix: "grok-imagine",
          chatOnly: true,
        },
        [
          { id: "grok-4", providerIds: ["xai"], endpointTypes: ["openai"] },
          { id: "grok-imagine-image", providerIds: ["xai"], endpointTypes: ["openai"] },
          { id: "gpt-4o", providerIds: ["openai"], endpointTypes: ["openai"] },
          { id: "grok-tts", providerIds: ["xai"], endpointTypes: ["openai-audio"] },
        ],
      ),
      ["grok-4"],
    );
  });
});

describe("channels", () => {
  it("starts empty and lets an admin create one", async () => {
    const fixture = await openFixture();
    try {
      assert.deepEqual(fixture.store.listChannels(), []);
      assert.equal(fixture.store.listUserChannelIds(fixture.userId).length, 0);
      const created = fixture.store.createChannel({
        name: "Grok",
        ratio: "0.1",
        rule: {
          kind: "models",
          modelIds: ["grok-4"],
        },
      });
      assert.equal(fixture.store.channelView(created).ratio, "0.1");
      fixture.store.setUserChannels(fixture.userId, [created.id]);
      const secret = fixture.store.createApiKey("grok", fixture.userId, created.id).secret;

      const listed = await models(fixture.app, secret);
      assert.deepEqual(ids(listed.json()), ["grok-4"]);

      const denied = await chat(fixture.app, secret, "gpt-4o");
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.message, "model not available");
      const image = await chat(fixture.app, secret, "grok-imagine-image");
      assert.equal(image.statusCode, 403);
      const allowed = await chat(fixture.app, secret, "grok-4");
      assert.equal(allowed.statusCode, 200);
      assert.deepEqual(fixture.calls, ["xai:grok-4"]);
      const xai = fixture.store.listConnections().find((connection) => connection.providerId === "xai");
      fixture.store.replaceConnectionModels(xai!.id, [
        { id: "grok-4", name: "Grok 4" },
        { id: "grok-4.1", name: "Grok 4.1" },
      ]);
      const later = await chat(fixture.app, secret, "grok-4.1");
      assert.equal(later.statusCode, 403);
      assert.equal(later.json().error.message, "model not available");
      await waitForBalance(fixture.dataDir, fixture.userId, 1_000_000_000 - 100_000);
    } finally {
      await fixture.close();
    }
  });

  it("charges the standard ratio across every published model", async () => {
    const fixture = await openFixture();
    try {
      const standard = fixture.store.createChannel({ name: "Standard", ratio: "7", rule: { kind: "all" } });
      fixture.store.setUserChannels(fixture.userId, [standard.id]);
      const secret = fixture.store.createApiKey("std", fixture.userId, standard.id).secret;
      assert.deepEqual(ids((await models(fixture.app, secret)).json()), ["gpt-4o", "grok-4", "grok-imagine-image"]);
      const response = await chat(fixture.app, secret, "gpt-4o");
      assert.equal(response.statusCode, 200);
      assert.deepEqual(fixture.calls, ["openai:gpt-4o"]);
      await waitForBalance(fixture.dataDir, fixture.userId, 1_000_000_000 - 7_000_000);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a key with no channel on the full catalog at the catalog price", async () => {
    const fixture = await openFixture();
    try {
      const listed = await models(fixture.app, fixture.unbound);
      assert.deepEqual(ids(listed.json()), ["gpt-4o", "grok-4", "grok-imagine-image"]);
      const response = await chat(fixture.app, fixture.unbound, "gpt-4o");
      assert.equal(response.statusCode, 200);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a key after the customer loses that channel", async () => {
    const fixture = await openFixture();
    try {
      const channel = fixture.store.createChannel({ name: "Standard", ratio: "1", rule: { kind: "all" } });
      fixture.store.setUserChannels(fixture.userId, [channel.id]);
      const secret = fixture.store.createApiKey("std", fixture.userId, channel.id).secret;
      fixture.store.setUserChannels(fixture.userId, []);
      const denied = await chat(fixture.app, secret, "gpt-4o");
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.message, "channel not available");
      assert.deepEqual(fixture.calls, []);
    } finally {
      await fixture.close();
    }
  });
});

describe("channel migration", () => {
  it("creates ordinary grok and standard rows for a database that already has customers", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-channel-migrate-"));
    const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        balance_nano INTEGER NOT NULL DEFAULT 0,
        inflight INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        user_id TEXT
      );
    `);
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, status, balance_nano, inflight, created_at, updated_at)
       VALUES ('user-old', 'old@example.com', 'Old', 'hash', 'active', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO api_keys (id, name, prefix, key_hash, created_at, user_id)
       VALUES ('key-old', 'legacy', 'viate_legacy', 'hash', '2026-01-01T00:00:00.000Z', NULL)`,
    ).run();
    db.close();
    const store = await AdminStore.open(dataDir);
    try {
      const channels = store.listChannels();
      assert.equal(channels.length, 2);
      const grok = channels.find((channel) => channel.name === "Grok");
      const standard = channels.find((channel) => channel.name === "Standard");
      assert.equal(store.channelView(grok!).ratio, "0.1");
      assert.deepEqual(grok?.rule, {
        kind: "models",
        modelIds: [],
      });
      assert.equal(store.channelView(standard!).ratio, "7");
      assert.deepEqual(standard?.rule, { kind: "all" });
      assert.deepEqual(store.listUserChannelIds("user-old"), [grok!.id]);
      assert.equal(store.listApiKeys().find((key) => key.id === "key-old")?.channelId, grok!.id);
      const again = await AdminStore.open(dataDir);
      try {
        assert.equal(again.listChannels().length, 2);
      } finally {
        again.close();
      }
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("freezes a stored prefix rule onto the models published at startup", async () => {
    const fixture = await openFixture();
    const channel = fixture.store.createChannel({ name: "Legacy", ratio: "1", rule: { kind: "all" } });
    const db = new DatabaseSync(join(fixture.dataDir, "viate.sqlite"));
    db.prepare("UPDATE channels SET model_rule = ? WHERE id = ?").run(
      JSON.stringify({
        kind: "match",
        providerId: "xai",
        prefix: "grok-",
        excludePrefix: "grok-imagine",
        chatOnly: true,
      }),
      channel.id,
    );
    db.close();
    await fixture.app.close();
    fixture.store.close();
    const reopened = await AdminStore.open(fixture.dataDir);
    try {
      assert.deepEqual(reopened.getChannel(channel.id)?.rule, {
        kind: "models",
        modelIds: ["grok-4"],
      });
    } finally {
      reopened.close();
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });
});

async function openFixture() {
  resetRoutingStateForTests();
  const dataDir = await mkdtemp(join(tmpdir(), "viate-channels-"));
  const store = await AdminStore.open(dataDir);
  const calls: string[] = [];
  const xai = store.createConnection("xai");
  const openai = store.createConnection("openai");
  store.putCredentials(xai.id, { token: "x" }, "xai");
  store.putCredentials(openai.id, { token: "o" }, "openai");
  store.setActive(xai.id, true);
  store.setActive(openai.id, true);
  store.replaceConnectionModels(xai.id, [
    { id: "grok-4", name: "Grok 4" },
    { id: "grok-imagine-image", name: "Imagine" },
  ]);
  store.replaceConnectionModels(openai.id, [{ id: "gpt-4o", name: "GPT-4o" }]);
  const user = store.createUser({ email: "customer@example.com", name: "Customer", password: "password1" });
  store.grantUsd(user.id, "1");
  const unbound = store.createApiKey("self-test").secret;
  const provider = (id: string): ProviderHandler => ({
    id,
    async chatCompletions(request) {
      const model = request.body && typeof request.body === "object" && "model" in request.body ? String(request.body.model) : "";
      calls.push(`${id}:${model}`);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        parseUsage: parseOpenAIChatUsage,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 0 } })));
            controller.close();
          },
        }),
      };
    },
  });
  const app = await buildApp({
    logger: false,
    store,
    providers: [provider("xai"), provider("openai")],
    modelPrices: {
      ready: true,
      lookup() {
        return { inputNanoPerMillion: 1_000_000_000, outputNanoPerMillion: 0 };
      },
    },
  });
  return {
    app,
    store,
    calls,
    unbound,
    userId: user.id,
    dataDir,
    async close() {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function models(app: App, secret: string) {
  return app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${secret}` } });
}

function chat(app: App, secret: string, model: string) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${secret}` },
    payload: { model, messages: [{ role: "user", content: "hi" }] },
  });
}

function ids(payload: { data: Array<{ id: string }> }): string[] {
  return payload.data.map((model) => model.id);
}

async function waitForBalance(dataDir: string, userId: string, expected: number) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
    try {
      const row = db.prepare("SELECT balance_nano FROM users WHERE id = ?").get(userId) as { balance_nano: number | bigint };
      if (Number(row.balance_nano) === expected) {
        return;
      }
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
  try {
    const row = db.prepare("SELECT balance_nano FROM users WHERE id = ?").get(userId) as { balance_nano: number | bigint };
    assert.equal(Number(row.balance_nano), expected);
  } finally {
    db.close();
  }
}
