import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AdminStore } from "./store.js";

describe("AdminStore connections", () => {
  let dataDir = "";
  let store: AdminStore;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-store-"));
    store = await AdminStore.open(dataDir);
  });

  after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("creates empty connections, encrypts credentials, and never lists secrets", async () => {
    const created = store.createConnection("openai-compatible");
    assert.equal(created.hasCredentials, false);
    assert.equal(created.active, false);
    assert.equal(created.displayLabel, created.id);
    assert.equal("credentials" in created, false);

    const withCreds = store.putCredentials(created.id, { baseUrl: "http://127.0.0.1", apiKey: "keep-me-secret" }, "primary");
    assert.equal(withCreds.hasCredentials, true);
    assert.equal(withCreds.displayLabel, "primary");
    assert.equal(withCreds.active, false);

    const keyStat = await stat(join(dataDir, "credential.key"));
    assert.equal(keyStat.mode & 0o777, 0o600);

    assert.equal(store.resolveActiveConnection(), null);
    store.setActive(created.id, true);
    const resolved = store.resolveActiveConnection();
    assert.equal(resolved?.connectionId, created.id);
    assert.equal(resolved?.providerId, "openai-compatible");
    assert.deepEqual(resolved?.credentials, { baseUrl: "http://127.0.0.1", apiKey: "keep-me-secret" });

    store.setActive(created.id, false);
    assert.equal(store.resolveActiveConnection(), null);

    const listed = store.listConnections();
    assert.equal(listed[0]?.hasCredentials, true);
    assert.equal("apiKey" in listed[0]!, false);
  });

  it("rejects activating a connection without credentials", () => {
    const created = store.createConnection("openai-compatible");
    assert.throws(() => store.setActive(created.id, true), /no credentials/);
  });

  it("keeps previously enabled connections when activating another", () => {
    const first = store.createConnection("openai-compatible");
    const second = store.createConnection("anthropic");
    store.putCredentials(first.id, { token: "a" }, "one");
    store.putCredentials(second.id, { token: "b" }, "two");
    store.setActive(first.id, true);
    store.setActive(second.id, true);
    assert.equal(store.getConnection(first.id)?.active, true);
    assert.equal(store.getConnection(second.id)?.active, true);
  });
});

describe("AdminStore API keys", () => {
  let dataDir = "";
  let store: AdminStore;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-keys-"));
    store = await AdminStore.open(dataDir);
  });

  after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("hashes client keys, lists prefixes only, verifies, and revokes", () => {
    const created = store.createApiKey("cli");
    assert.match(created.secret, /^viate_/);
    assert.equal(created.apiKey.prefix, created.secret.slice(0, 12));
    assert.equal(store.listApiKeys()[0]?.prefix, created.apiKey.prefix);
    assert.equal("secret" in store.listApiKeys()[0]!, false);
    assert.equal(store.verifyApiKey(created.secret)?.id, created.apiKey.id);
    store.deleteApiKey(created.apiKey.id);
    assert.equal(store.verifyApiKey(created.secret), null);
  });

  it("rejects empty names and missing ids", () => {
    assert.throws(() => store.createApiKey(" "), /name is required/);
    assert.throws(() => store.deleteApiKey("missing"), /api key not found/);
  });
});

describe("AdminStore request logs", () => {
  let dataDir = "";
  let store: AdminStore;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-request-logs-"));
    store = await AdminStore.open(dataDir);
  });

  after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("stores request metadata, attempts, and minute rollup without payloads", () => {
    const id = "req-1";
    store.insertRequestLog(
      {
        id,
        startedAt: "2026-09-18T00:00:10.000Z",
        endedAt: "2026-09-18T00:00:11.200Z",
        durationMs: 1200,
        ttfbMs: 80,
        endpoint: "chat.completions",
        stream: false,
        status: 200,
        outcome: "success",
        requestModel: "demo",
        upstreamModel: "gpt-4o",
        providerId: "openai-compatible",
        connectionId: "conn-1",
        apiKeyId: "key-1",
        apiKeyPrefix: "viate_abc",
        attemptCount: 1,
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 8,
        cacheWriteTokens: 0,
        usageSource: "parser",
        error: null,
        payloadPath: "request-logs/2026-09-18.jsonl",
        payloadOffset: 0,
        payloadTruncated: false,
      },
      [
        {
          seq: 1,
          providerId: "openai-compatible",
          connectionId: "conn-1",
          upstreamModel: "gpt-4o",
          status: 200,
          durationMs: 1200,
          error: null,
        },
      ],
    );

    const listed = store.listRequestLogs({ model: "demo" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, id);
    assert.equal(listed[0]?.inputTokens, 20);
    assert.equal(listed[0]?.cacheReadTokens, 8);
    assert.equal("request" in listed[0]!, false);

    const detail = store.getRequestLog(id);
    assert.equal(detail?.attempts.length, 1);
    assert.equal(detail?.attempts[0]?.connectionId, "conn-1");

    const stats = store.requestLogStats("1h", Date.parse("2026-09-18T00:30:00.000Z"));
    assert.equal(stats.requests, 1);
    assert.equal(stats.inputTokens, 20);
    assert.equal(stats.outputTokens, 5);
    assert.equal(stats.cacheReadTokens, 8);
  });
});

describe("AdminStore connection models", () => {
  let dataDir = "";
  let store: AdminStore;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-models-"));
    store = await AdminStore.open(dataDir);
  });

  after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("replaces a connection catalog and keeps later ids enabled", () => {
    const connection = store.createConnection("openai-compatible");
    const first = store.replaceConnectionModels(connection.id, [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini" },
    ]);
    assert.equal((first.syncedAt ?? "").length > 0, true);
    assert.deepEqual(
      first.models.map((model) => ({ id: model.id, name: model.name, enabled: model.enabled })),
      [
        { id: "gpt-4o", name: "GPT-4o", enabled: true },
        { id: "gpt-4o-mini", name: "gpt-4o-mini", enabled: true },
      ],
    );

    store.setConnectionModelEnabled(connection.id, "gpt-4o-mini", false);
    const second = store.replaceConnectionModels(connection.id, [
      { id: "gpt-4o-mini", name: "GPT-4o mini" },
      { id: "o3" },
    ]);
    assert.deepEqual(
      second.models.map((model) => ({ id: model.id, name: model.name, enabled: model.enabled })),
      [
        { id: "gpt-4o-mini", name: "GPT-4o mini", enabled: false },
        { id: "o3", name: "o3", enabled: true },
      ],
    );
  });

  it("lists enabled models only for the active connection", () => {
    const inactive = store.createConnection("openai-compatible");
    const active = store.createConnection("openai-compatible");
    store.putCredentials(inactive.id, { token: "a" }, "inactive");
    store.putCredentials(active.id, { token: "b" }, "active");
    store.replaceConnectionModels(inactive.id, [{ id: "hidden" }]);
    store.replaceConnectionModels(active.id, [{ id: "keep" }, { id: "off" }]);
    store.setConnectionModelEnabled(active.id, "off", false);
    store.setActive(active.id, true);

    assert.deepEqual(store.listPublicCatalog(), {
      object: "list",
      data: [
        {
          id: "keep",
          object: "model",
          owned_by: "openai-compatible",
          supported_endpoint_types: ["openai", "openai-response"],
        },
      ],
    });
    store.deleteConnection(active.id);
    assert.throws(() => store.getConnectionModels(active.id), /connection not found/);
    assert.deepEqual(store.listPublicCatalog(), { object: "list", data: [] });
  });

  it("aggregates the same id across connections and providers", () => {
    const left = store.createConnection("openai-compatible");
    const right = store.createConnection("openai-compatible");
    const other = store.createConnection("anthropic");
    store.putCredentials(left.id, { token: "a" }, "left");
    store.putCredentials(right.id, { token: "b" }, "right");
    store.putCredentials(other.id, { token: "c" }, "other");
    store.replaceConnectionModels(left.id, [{ id: "gpt-4o" }]);
    store.replaceConnectionModels(right.id, [{ id: "gpt-4o" }]);
    store.replaceConnectionModels(other.id, [{ id: "gpt-4o" }]);
    store.setActive(left.id, true);
    store.setActive(right.id, true);
    assert.deepEqual(store.listPublicCatalog().data, [
      {
        id: "gpt-4o",
        object: "model",
        owned_by: "openai-compatible",
        supported_endpoint_types: ["openai", "openai-response"],
      },
    ]);
    store.setActive(other.id, true);
    assert.deepEqual(store.listPublicCatalog().data, [
      {
        id: "gpt-4o",
        object: "model",
        owned_by: "viate",
        supported_endpoint_types: ["openai", "openai-response"],
        children: [
          { id: "openai-compatible/gpt-4o", owned_by: "openai-compatible" },
          { id: "anthropic/gpt-4o", owned_by: "anthropic" },
        ],
      },
    ]);
    store.setPublishedModelProviders("gpt-4o", ["anthropic", "openai-compatible"]);
    assert.deepEqual(
      store.listPublicCatalog().data[0]?.children?.map((child) => child.id),
      ["anthropic/gpt-4o", "openai-compatible/gpt-4o"],
    );
  });
});

describe("AdminStore public catalog proxy fields", () => {
  let dataDir = "";
  let store: AdminStore;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-store-catalog-"));
    store = await AdminStore.open(dataDir);
  });

  after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("emits proxy name and the largest known context window", () => {
    const left = store.createConnection("openai-compatible");
    const right = store.createConnection("anthropic");
    store.putCredentials(left.id, { token: "a" }, "left");
    store.putCredentials(right.id, { token: "b" }, "right");
    store.replaceConnectionModels(left.id, [
      { id: "gpt-4o", name: "GPT-4o", context_length: 128000 },
    ]);
    store.replaceConnectionModels(right.id, [{ id: "gpt-4o", context_length: 200000 }]);
    store.setActive(left.id, true);
    store.setActive(right.id, true);
    assert.deepEqual(store.listPublicCatalog().data, [
      {
        id: "gpt-4o",
        object: "model",
        owned_by: "viate",
        name: "GPT-4o",
        supported_endpoint_types: ["openai", "openai-response"],
        context_length: 200000,
        children: [
          { id: "openai-compatible/gpt-4o", owned_by: "openai-compatible" },
          { id: "anthropic/gpt-4o", owned_by: "anthropic" },
        ],
      },
    ]);
  });

  it("filters advertised endpoint types per provider without hiding the model", () => {
    const connection = store.createConnection("codex");
    store.putCredentials(connection.id, { token: "a" }, "codex");
    store.replaceConnectionModels(connection.id, [{ id: "gpt-5.5" }]);
    store.setActive(connection.id, true);
    assert.deepEqual(store.getAdvertisedEndpointTypes("codex"), ["openai", "openai-response"]);
    assert.deepEqual(store.setAdvertisedEndpointTypes("codex", ["openai-response"]), ["openai-response"]);
    const catalog = store.listPublicCatalog().data.find((model) => model.id === "gpt-5.5");
    assert.deepEqual(catalog, {
      id: "gpt-5.5",
      object: "model",
      owned_by: "codex",
      supported_endpoint_types: ["openai-response"],
    });
    assert.deepEqual(store.setAdvertisedEndpointTypes("codex", []), []);
    assert.deepEqual(
      store.listPublicCatalog().data.find((model) => model.id === "gpt-5.5")?.supported_endpoint_types,
      [],
    );
  });

  it("unions advertised endpoint types across contributing providers", () => {
    const chat = store.createConnection("grok");
    const responses = store.createConnection("codex");
    store.putCredentials(chat.id, { token: "g" }, "grok");
    store.putCredentials(responses.id, { token: "c" }, "codex");
    store.replaceConnectionModels(chat.id, [{ id: "shared" }]);
    store.replaceConnectionModels(responses.id, [{ id: "shared" }]);
    store.setActive(chat.id, true);
    store.setActive(responses.id, true);
    store.setAdvertisedEndpointTypes("grok", ["openai"]);
    store.setAdvertisedEndpointTypes("codex", ["openai-response"]);
    assert.deepEqual(
      store.listPublicCatalog().data.find((model) => model.id === "shared")?.supported_endpoint_types,
      ["openai", "openai-response"],
    );
  });

  it("adds context_length to existing connection_models tables", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-store-migrate-models-"));
    const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
    db.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        credentials_enc TEXT,
        display_label TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        keepalive_status TEXT NOT NULL DEFAULT 'idle',
        keepalive_error TEXT,
        keepalive_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE connection_models (
        connection_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, model_id),
        FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
      );
    `);
    db.close();
    const migrated = await AdminStore.open(dataDir);
    try {
      const connection = migrated.createConnection("openai-compatible");
      migrated.putCredentials(connection.id, { token: "a" }, "a");
      migrated.replaceConnectionModels(connection.id, [{ id: "gpt-4o", context_length: 128000 }]);
      migrated.setActive(connection.id, true);
      assert.equal(migrated.listPublicCatalog().data[0]?.context_length, 128000);
      assert.deepEqual(migrated.listPublicCatalog().data[0]?.supported_endpoint_types, [
        "openai",
        "openai-response",
      ]);
    } finally {
      migrated.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
