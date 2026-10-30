import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AdminStore, type RequestLogRecord } from "./store.js";

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return undefined;
}

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

  it("adds custom models, rejects duplicates, and preserves them across sync", () => {
    const connection = store.createConnection("openai-compatible");
    assert.throws(
      () => store.addConnectionModel(connection.id, { id: "  " }),
      (error: unknown) => statusOf(error) === 400 && error instanceof Error && /model id is required/.test(error.message),
    );
    assert.throws(
      () => store.addConnectionModel("missing", { id: "voice" }),
      (error: unknown) => statusOf(error) === 404,
    );

    assert.throws(
      () => store.addConnectionModel(connection.id, { id: "needs-types" }),
      (error: unknown) => statusOf(error) === 400 && error instanceof Error && /endpointTypes is required/.test(error.message),
    );
    assert.throws(
      () => store.addConnectionModel(connection.id, { id: "needs-types", endpointTypes: [] }),
      (error: unknown) => statusOf(error) === 400 && error instanceof Error && /endpointTypes is required/.test(error.message),
    );
    assert.throws(
      () => store.addConnectionModel(connection.id, { id: "needs-types", endpointTypes: ["anthropic"] }),
      (error: unknown) => statusOf(error) === 400 && error instanceof Error && /unsupported endpoint type/.test(error.message),
    );

    const added = store.addConnectionModel(connection.id, {
      id: " grok-voice-transcribe-2.0 ",
      name: " Voice ",
      endpointTypes: ["openai-audio", "openai"],
    });
    assert.deepEqual(added.models.find((model) => model.id === "grok-voice-transcribe-2.0"), {
      id: "grok-voice-transcribe-2.0",
      name: "Voice",
      enabled: true,
      custom: true,
      endpointTypes: ["openai", "openai-audio"],
    });
    const unnamed = store.addConnectionModel(connection.id, { id: "plain", endpointTypes: ["openai-response"] });
    assert.equal(unnamed.models.find((model) => model.id === "plain")?.name, "plain");
    assert.deepEqual(unnamed.models.find((model) => model.id === "plain")?.endpointTypes, ["openai-response"]);
    assert.throws(
      () => store.addConnectionModel(connection.id, { id: "grok-voice-transcribe-2.0", endpointTypes: ["openai-audio"] }),
      (error: unknown) => statusOf(error) === 409 && error instanceof Error && /model already exists/.test(error.message),
    );

    store.setConnectionModelEnabled(connection.id, "grok-voice-transcribe-2.0", false);
    const kept = store.replaceConnectionModels(connection.id, [{ id: "gpt-4o", name: "GPT-4o" }]);
    assert.deepEqual(kept.models.find((model) => model.id === "grok-voice-transcribe-2.0"), {
      id: "grok-voice-transcribe-2.0",
      name: "Voice",
      enabled: false,
      custom: true,
      endpointTypes: ["openai", "openai-audio"],
    });
    assert.equal(kept.models.find((model) => model.id === "plain")?.custom, true);
    assert.deepEqual(kept.models.find((model) => model.id === "plain")?.endpointTypes, ["openai-response"]);
    assert.equal(kept.models.find((model) => model.id === "gpt-4o")?.custom, false);
    assert.equal("endpointTypes" in (kept.models.find((model) => model.id === "gpt-4o") ?? {}), false);

    store.addConnectionModel(connection.id, { id: "o3", name: "manual", endpointTypes: ["openai-audio"] });
    store.setConnectionModelEnabled(connection.id, "o3", false);
    const converted = store.replaceConnectionModels(connection.id, [
      { id: "o3", name: "O3", context_length: 200000 },
      { id: "gpt-4o", name: "GPT-4o upstream", context_length: 128000 },
    ]);
    assert.deepEqual(converted.models.find((model) => model.id === "o3"), {
      id: "o3",
      name: "O3",
      enabled: false,
      custom: false,
      contextLength: 200000,
    });
    assert.equal(converted.models.find((model) => model.id === "gpt-4o")?.name, "GPT-4o upstream");
    assert.equal(converted.models.find((model) => model.id === "gpt-4o")?.custom, false);
    assert.equal("endpointTypes" in (converted.models.find((model) => model.id === "o3") ?? {}), false);
    assert.equal(converted.models.find((model) => model.id === "grok-voice-transcribe-2.0")?.custom, true);
    assert.equal(converted.models.find((model) => model.id === "grok-voice-transcribe-2.0")?.enabled, false);
    assert.deepEqual(converted.models.find((model) => model.id === "grok-voice-transcribe-2.0")?.endpointTypes, [
      "openai",
      "openai-audio",
    ]);

    assert.throws(
      () => store.setConnectionModelEndpointTypes(connection.id, "gpt-4o", ["openai-audio"]),
      (error: unknown) =>
        statusOf(error) === 400 && error instanceof Error && /synced model endpoints cannot be changed/.test(error.message),
    );
    assert.equal(store.getConnectionModels(connection.id).models.find((model) => model.id === "gpt-4o")?.name, "GPT-4o upstream");
    assert.throws(
      () => store.setConnectionModelEndpointTypes(connection.id, "missing-model", ["openai"]),
      (error: unknown) => statusOf(error) === 404,
    );
    const updated = store.setConnectionModelEndpointTypes(connection.id, "plain", ["openai-image", "openai-audio"]);
    assert.deepEqual(updated.models.find((model) => model.id === "plain"), {
      id: "plain",
      name: "plain",
      enabled: true,
      custom: true,
      endpointTypes: ["openai-image", "openai-audio"],
    });

    assert.throws(
      () => store.deleteConnectionModel(connection.id, "gpt-4o"),
      (error: unknown) => statusOf(error) === 400 && error instanceof Error && /synced model cannot be removed/.test(error.message),
    );
    assert.throws(
      () => store.deleteConnectionModel(connection.id, "missing-model"),
      (error: unknown) => statusOf(error) === 404,
    );
    const removed = store.deleteConnectionModel(connection.id, "grok-voice-transcribe-2.0");
    assert.equal(removed.models.some((model) => model.id === "grok-voice-transcribe-2.0"), false);
    assert.equal(removed.models.find((model) => model.id === "plain")?.custom, true);
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
    assert.deepEqual(store.setAdvertisedEndpointTypes("codex", ["openai", "openai-audio"]), [
      "openai",
      "openai-audio",
    ]);
    assert.deepEqual(
      store.listPublicCatalog().data.find((model) => model.id === "gpt-5.5")?.supported_endpoint_types,
      ["openai", "openai-audio"],
    );
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

  it("publishes custom endpoint types without the provider advertisement", () => {
    const connection = store.createConnection("xai");
    store.putCredentials(connection.id, { token: "x" }, "xai");
    store.setActive(connection.id, true);
    store.setAdvertisedEndpointTypes("xai", ["openai-response"]);
    store.addConnectionModel(connection.id, {
      id: "grok-tts",
      endpointTypes: ["openai-audio", "openai-audio"],
    });
    assert.deepEqual(
      store.listPublicCatalog().data.find((model) => model.id === "grok-tts")?.supported_endpoint_types,
      ["openai-audio"],
    );
    store.setAdvertisedEndpointTypes("xai", []);
    assert.deepEqual(
      store.listPublicCatalog().data.find((model) => model.id === "grok-tts")?.supported_endpoint_types,
      ["openai-audio"],
    );
  });

  it("unions custom and synced members in public endpoint order", () => {
    const audio = store.createConnection("xai-audio");
    const chat = store.createConnection("chat-sync");
    store.putCredentials(audio.id, { token: "a" }, "audio");
    store.putCredentials(chat.id, { token: "c" }, "chat");
    store.setActive(audio.id, true);
    store.setActive(chat.id, true);
    store.setAdvertisedEndpointTypes("xai-audio", ["openai-response"]);
    store.setAdvertisedEndpointTypes("chat-sync", ["openai"]);
    store.addConnectionModel(audio.id, { id: "shared-voice", endpointTypes: ["openai-audio"] });
    store.replaceConnectionModels(chat.id, [{ id: "shared-voice" }]);
    assert.deepEqual(
      store.listPublicCatalog().data.find((model) => model.id === "shared-voice")?.supported_endpoint_types,
      ["openai", "openai-audio"],
    );

    const images = store.createConnection("image-custom");
    store.putCredentials(images.id, { token: "i" }, "images");
    store.setActive(images.id, true);
    store.setAdvertisedEndpointTypes("image-custom", ["openai-response"]);
    store.addConnectionModel(images.id, { id: "shared-voice", endpointTypes: ["openai-image"] });
    assert.deepEqual(
      store.listPublicCatalog().data.find((model) => model.id === "shared-voice")?.supported_endpoint_types,
      ["openai", "openai-image", "openai-audio"],
    );
  });

  it("inherits provider endpoint types when a custom row has none stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "viate-custom-endpoint-inherit-"));
    const opened = await AdminStore.open(dir);
    const connection = opened.createConnection("grok");
    opened.putCredentials(connection.id, { token: "g" }, "grok");
    opened.setActive(connection.id, true);
    opened.setAdvertisedEndpointTypes("grok", ["openai-response"]);
    opened.addConnectionModel(connection.id, { id: "legacy-tts", name: "Legacy", endpointTypes: ["openai"] });
    opened.close();
    const db = new DatabaseSync(join(dir, "viate.sqlite"));
    db.prepare("UPDATE connection_models SET endpoint_types = NULL WHERE model_id = ?").run("legacy-tts");
    db.close();
    const reopened = await AdminStore.open(dir);
    try {
      const row = reopened.getConnectionModels(connection.id).models.find((model) => model.id === "legacy-tts");
      assert.equal(row?.custom, true);
      assert.equal(row?.name, "Legacy");
      assert.equal(row?.endpointTypes, null);
      assert.deepEqual(
        reopened.listPublicCatalog().data.find((model) => model.id === "legacy-tts")?.supported_endpoint_types,
        ["openai-response"],
      );
      const updated = reopened.setConnectionModelEndpointTypes(connection.id, "legacy-tts", ["openai-audio", "openai-image"]);
      assert.equal(updated.models.find((model) => model.id === "legacy-tts")?.enabled, true);
      assert.equal(updated.models.find((model) => model.id === "legacy-tts")?.name, "Legacy");
      assert.deepEqual(updated.models.find((model) => model.id === "legacy-tts")?.endpointTypes, [
        "openai-image",
        "openai-audio",
      ]);
      assert.deepEqual(
        reopened.listPublicCatalog().data.find((model) => model.id === "legacy-tts")?.supported_endpoint_types,
        ["openai-image", "openai-audio"],
      );
      const kept = reopened.replaceConnectionModels(connection.id, [{ id: "gpt-4o" }]);
      assert.deepEqual(kept.models.find((model) => model.id === "legacy-tts")?.endpointTypes, [
        "openai-image",
        "openai-audio",
      ]);
      reopened.addConnectionModel(connection.id, { id: "adopted", endpointTypes: ["openai-audio"] });
      const adopted = reopened.replaceConnectionModels(connection.id, [
        { id: "adopted", name: "Adopted" },
        { id: "gpt-4o" },
      ]);
      const adoptedRow = adopted.models.find((model) => model.id === "adopted");
      assert.equal(adoptedRow?.custom, false);
      assert.equal(adoptedRow?.name, "Adopted");
      assert.equal("endpointTypes" in (adoptedRow ?? {}), false);
      assert.deepEqual(
        reopened.listPublicCatalog().data.find((model) => model.id === "adopted")?.supported_endpoint_types,
        ["openai-response"],
      );
      assert.deepEqual(
        reopened.listPublicCatalog().data.find((model) => model.id === "legacy-tts")?.supported_endpoint_types,
        ["openai-image", "openai-audio"],
      );
    } finally {
      reopened.close();
      await rm(dir, { recursive: true, force: true });
    }
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

  it("defaults existing connection models to not custom", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-store-migrate-custom-"));
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
      INSERT INTO connections (id, provider_id, created_at, updated_at)
      VALUES ('c1', 'openai-compatible', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      CREATE TABLE connection_models (
        connection_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL,
        context_length INTEGER,
        PRIMARY KEY (connection_id, model_id)
      );
      INSERT INTO connection_models (connection_id, model_id, name, enabled, synced_at, context_length)
      VALUES ('c1', 'gpt-4o', 'GPT-4o', 0, '2026-01-01T00:00:00.000Z', 128000);
    `);
    db.close();
    const migrated = await AdminStore.open(dataDir);
    try {
      const catalog = migrated.getConnectionModels("c1");
      assert.deepEqual(catalog.models, [
        { id: "gpt-4o", name: "GPT-4o", enabled: false, custom: false, contextLength: 128000 },
      ]);
    } finally {
      migrated.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("adds endpoint_types and leaves existing custom rows inheriting", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-store-migrate-endpoints-"));
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
      INSERT INTO connections (id, provider_id, created_at, updated_at)
      VALUES ('c1', 'grok', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      CREATE TABLE connection_models (
        connection_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL,
        context_length INTEGER,
        custom INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (connection_id, model_id)
      );
      INSERT INTO connection_models (connection_id, model_id, name, enabled, synced_at, custom)
      VALUES ('c1', 'grok-tts', 'grok-tts', 1, '2026-01-01T00:00:00.000Z', 1);
    `);
    db.close();
    const migrated = await AdminStore.open(dataDir);
    try {
      assert.deepEqual(migrated.getConnectionModels("c1").models, [
        { id: "grok-tts", name: "grok-tts", enabled: true, custom: true, endpointTypes: null },
      ]);
    } finally {
      migrated.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("AdminStore request log browsing", () => {
  let dataDir = "";
  let store: AdminStore;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-request-browse-"));
    store = await AdminStore.open(dataDir);
    insertLog(store, { id: "filter-alpha", startedAt: "2026-07-01T00:00:00.000Z", requestModel: "alpha-filter" });
    insertLog(store, {
      id: "filter-conn",
      startedAt: "2026-07-01T01:00:00.000Z",
      requestModel: "other-filter",
      connectionId: "conn-b",
      providerId: "prov-b",
    });
    insertLog(store, {
      id: "filter-key",
      startedAt: "2026-07-01T02:00:00.000Z",
      apiKeyId: "key-special",
      outcome: "timeout",
      status: 504,
    });
    insertLog(store, {
      id: "filter-embed",
      startedAt: "2026-07-01T03:00:00.000Z",
      endpoint: "embeddings",
      outcome: "client_error",
      status: 400,
    });
    insertLog(store, { id: "filter-early", startedAt: "2026-07-02T00:00:00.000Z", requestModel: "windowed" });
    insertLog(store, { id: "filter-late", startedAt: "2026-07-02T06:00:00.000Z", requestModel: "windowed" });
    insertLog(store, { id: "page-c", startedAt: "2026-06-01T03:00:00.000Z", requestModel: "cursor-time" });
    insertLog(store, { id: "page-b", startedAt: "2026-06-01T02:00:00.000Z", requestModel: "cursor-time" });
    insertLog(store, { id: "page-a", startedAt: "2026-06-01T01:00:00.000Z", requestModel: "cursor-time" });
    insertLog(store, { id: "tie-z", startedAt: "2026-06-02T00:00:00.000Z", requestModel: "cursor-tie" });
    insertLog(store, { id: "tie-m", startedAt: "2026-06-02T00:00:00.000Z", requestModel: "cursor-tie" });
    insertLog(store, {
      id: "stats-alpha-1",
      startedAt: "2026-09-18T00:10:15.000Z",
      requestModel: "alpha",
      connectionId: "conn-a",
      providerId: "prov-a",
      durationMs: 2000,
      ttfbMs: 400,
      stream: true,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 4,
    });
    insertLog(store, {
      id: "stats-beta-err",
      startedAt: "2026-09-18T00:20:00.000Z",
      requestModel: "beta",
      connectionId: "conn-b",
      providerId: "prov-b",
      endpoint: "embeddings",
      outcome: "upstream_error",
      status: 502,
      durationMs: 1000,
      ttfbMs: null,
      inputTokens: 20,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      error: "upstream failed",
    });
    insertLog(store, {
      id: "stats-alpha-abort",
      startedAt: "2026-09-18T00:30:00.000Z",
      requestModel: "alpha",
      connectionId: "conn-a",
      providerId: "prov-a",
      outcome: "aborted",
      status: 499,
      durationMs: 500,
      ttfbMs: 50,
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 2,
    });
    insertLog(store, {
      id: "stats-outside",
      startedAt: "2026-09-18T02:00:00.000Z",
      requestModel: "alpha",
      inputTokens: 1000,
      outputTokens: 1000,
    });
  });

  after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("filters request logs by model, connection, key, outcome, endpoint, and time", () => {
    assert.deepEqual(ids(store, { model: "alpha-filter" }), ["filter-alpha"]);
    assert.deepEqual(ids(store, { connectionId: "conn-b", from: "2026-07-01T00:00:00.000Z", to: "2026-07-01T23:00:00.000Z" }), [
      "filter-conn",
    ]);
    assert.deepEqual(ids(store, { providerId: "prov-b", from: "2026-07-01T00:00:00.000Z", to: "2026-07-01T23:00:00.000Z" }), [
      "filter-conn",
    ]);
    assert.deepEqual(ids(store, { keyId: "key-special" }), ["filter-key"]);
    assert.deepEqual(ids(store, { outcome: "timeout" }), ["filter-key"]);
    assert.deepEqual(ids(store, { endpoint: "embeddings", from: "2026-07-01T00:00:00.000Z", to: "2026-07-01T23:00:00.000Z" }), [
      "filter-embed",
    ]);
    assert.deepEqual(
      ids(store, { model: "windowed", from: "2026-07-02T05:00:00.000Z", to: "2026-07-02T07:00:00.000Z" }),
      ["filter-late"],
    );
  });

  it("pages older than the cursor and sets nextBefore only for a full page", () => {
    const first = store.listRequestLogPage({ model: "cursor-time", limit: 2 });
    assert.deepEqual(first.requests.map((row) => row.id), ["page-c", "page-b"]);
    assert.equal(first.nextBefore, "2026-06-01T02:00:00.000Z|page-b");

    const second = store.listRequestLogPage({ model: "cursor-time", limit: 2, before: first.nextBefore ?? "" });
    assert.deepEqual(second.requests.map((row) => row.id), ["page-a"]);
    assert.equal(second.requests.some((row) => row.id === "page-b"), false);
    assert.equal(second.nextBefore, null);

    const all = store.listRequestLogPage({ model: "cursor-time", limit: 50 });
    assert.equal(all.requests.length, 3);
    assert.equal(all.nextBefore, null);

    const tied = store.listRequestLogPage({
      model: "cursor-tie",
      before: "2026-06-02T00:00:00.000Z|tie-z",
    });
    assert.deepEqual(tied.requests.map((row) => row.id), ["tie-m"]);
  });

  it("aggregates filtered stats, error rate, rpm, buckets, and model order", () => {
    const from = "2026-09-18T00:00:00.000Z";
    const to = "2026-09-18T01:00:00.000Z";
    const stats = store.queryRequestLogStats({ from, to });
    assert.equal(stats.from, from);
    assert.equal(stats.to, to);
    assert.equal(stats.requests, 3);
    assert.equal(stats.errors, 1);
    assert.equal(stats.aborted, 1);
    assert.equal(stats.errorRate, 0.5);
    assert.equal(stats.rpm, 3 / 60);
    assert.equal(stats.inputTokens, 125);
    assert.equal(stats.outputTokens, 51);
    assert.equal(stats.cacheReadTokens, 10);
    assert.equal(stats.cacheWriteTokens, 6);
    assert.equal(stats.tpm, 176 / 60);
    assert.equal(stats.inputTpm, 125 / 60);
    assert.equal(stats.outputTpm, 51 / 60);
    assert.equal(stats.cacheReadTpm, 10 / 60);
    assert.equal(stats.cacheWriteTpm, 6 / 60);
    assert.equal(stats.avgDurationMs, 3500 / 3);
    assert.equal(stats.avgTtfbMs, 225);
    assert.equal(stats.outputTps, 51 / (3500 / 1000));
    assert.deepEqual(stats.series.map((row) => row.t), [
      "2026-09-18T00:10:00.000Z",
      "2026-09-18T00:20:00.000Z",
      "2026-09-18T00:30:00.000Z",
    ]);
    assert.equal(stats.series[1]?.errors, 1);
    assert.equal(stats.series[0]?.cacheReadTokens, 10);
    assert.deepEqual(stats.byModel.map((row) => row.model), ["alpha", "beta"]);
    assert.equal(stats.byModel[0]?.requests, 2);
    assert.equal(stats.byModel[1]?.errors, 1);
    assert.deepEqual(stats.byConnection.map((row) => [row.connectionId, row.requests]), [
      ["conn-a", 2],
      ["conn-b", 1],
    ]);

    const hour = store.queryRequestLogStats({ from, to: "2026-09-18T03:00:00.000Z" });
    assert.equal(hour.series[0]?.t, "2026-09-18T00:00:00.000Z");
    const minuteBoundary = store.queryRequestLogStats({ from, to: "2026-09-18T02:00:00.000Z" });
    assert.equal(minuteBoundary.series[0]?.t, "2026-09-18T00:10:00.000Z");
    const day = store.queryRequestLogStats({ from: "2026-09-16T00:00:00.000Z", to });
    assert.equal(day.series[0]?.t, "2026-09-18T00:00:00.000Z");

    const instant = store.queryRequestLogStats({
      from: "2026-09-18T00:10:15.000Z",
      to: "2026-09-18T00:10:15.000Z",
    });
    assert.equal(instant.requests, 1);
    assert.equal(instant.rpm, 1);
  });
});

function insertLog(store: AdminStore, overrides: Partial<RequestLogRecord> & { id: string; startedAt: string }): void {
  store.insertRequestLog(
    {
      endedAt: overrides.startedAt,
      durationMs: 100,
      ttfbMs: null,
      endpoint: "chat.completions",
      stream: false,
      status: 200,
      outcome: "success",
      requestModel: "demo",
      upstreamModel: "demo",
      providerId: "prov",
      connectionId: "conn",
      apiKeyId: "key",
      apiKeyPrefix: "viate_x",
      attemptCount: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "parser",
      error: null,
      payloadPath: null,
      payloadOffset: null,
      payloadTruncated: false,
      ...overrides,
    },
    [],
  );
}

function ids(store: AdminStore, query: Parameters<AdminStore["listRequestLogs"]>[0]): string[] {
  return store.listRequestLogs(query).map((row) => row.id);
}
