import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { ProviderHandler } from "@viateai/sdk";
import { buildApp, type App } from "./app.js";
import type { ModelPriceLookup } from "./chat.js";
import { AdminStore } from "./store.js";

type ProviderCall = { capability: string; body: unknown; connectionId: string };

const MODEL = "grok-imagine-video";

describe("POST /v1/videos", () => {
  it("submits a job and serves a later poll from the stored connection", async () => {
    const fixture = await openVideoApp();
    try {
      const submitted = await fixture.app.inject({
        method: "POST",
        url: "/v1/videos/generations",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: MODEL, prompt: "a lighthouse", duration: 6, aspect_ratio: "16:9" },
      });
      assert.equal(submitted.statusCode, 200);
      assert.deepEqual(submitted.json(), { request_id: "vid-123" });
      assert.deepEqual(fixture.calls[0], {
        capability: "videoGenerations",
        connectionId: fixture.connectionId,
        body: { model: MODEL, prompt: "a lighthouse", duration: 6, aspect_ratio: "16:9" },
      });
      assert.deepEqual(fixture.store.getVideoRequest("vid-123"), {
        requestId: "vid-123",
        connectionId: fixture.connectionId,
        providerId: "fake-video",
        modelId: MODEL,
        userId: null,
        apiKeyId: fixture.apiKeyId,
        createdAt: fixture.store.getVideoRequest("vid-123")?.createdAt ?? "",
      });

      const polled = await fixture.app.inject({
        method: "GET",
        url: "/v1/videos/vid-123",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.equal(polled.statusCode, 200);
      assert.deepEqual(polled.json(), {
        request_id: "vid-123",
        status: "completed",
        video: { url: "https://videos.x.ai/vid-123.mp4" },
      });
      assert.deepEqual(fixture.calls[1], {
        capability: "videoResult",
        connectionId: fixture.connectionId,
        body: { request_id: "vid-123" },
      });

      fixture.store.setActive(fixture.connectionId, false);
      const polledInactive = await fixture.app.inject({
        method: "GET",
        url: "/v1/videos/vid-123",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.equal(polledInactive.statusCode, 200);
    } finally {
      await fixture.close();
    }
  });

  it("inlines a multipart image file and parses JSON and numeric text fields", async () => {
    const fixture = await openVideoApp();
    try {
      const boundary = "viate-video";
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const response = await fixture.app.inject({
        method: "POST",
        url: "/v1/videos/generations",
        headers: {
          authorization: `Bearer ${fixture.secret}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${MODEL}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\npan across the bay\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="duration"\r\n\r\n6\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="keyframes"\r\n\r\n[{"timestamp_s":2,"image":"https://example.com/a.png"}]\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="first.png"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          png,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(fixture.calls[0]?.body, {
        model: MODEL,
        prompt: "pan across the bay",
        duration: 6,
        keyframes: [{ timestamp_s: 2, image: "https://example.com/a.png" }],
        image: { b64_json: png.toString("base64"), media_type: "image/png" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("returns 404 when the provider does not implement video generation", async () => {
    const fixture = await openVideoApp({
      provider: { id: "fake-video", async chatCompletions() { return { status: 200, headers: {}, body: null }; } },
    });
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/v1/videos/generations",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: MODEL, prompt: "a lighthouse" },
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: { message: "capability not supported", type: "viate_error" } });
    } finally {
      await fixture.close();
    }
  });
});

describe("GET /v1/videos/:requestId", () => {
  it("rejects an unknown id without calling the provider", async () => {
    const fixture = await openVideoApp();
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/videos/missing-job",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: { message: "unknown video request", type: "viate_error" } });
      assert.equal(fixture.calls.length, 0);
    } finally {
      await fixture.close();
    }
  });

  it("returns 404 when the routed connection lost its credentials", async () => {
    const fixture = await openVideoApp();
    try {
      await fixture.app.inject({
        method: "POST",
        url: "/v1/videos/generations",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: MODEL, prompt: "a lighthouse" },
      });
      fixture.store.clearCredentials(fixture.connectionId);
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/videos/vid-123",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: { message: "unknown video request", type: "viate_error" } });
      assert.equal(fixture.calls.length, 1);
    } finally {
      await fixture.close();
    }
  });

  it("binds a job to its owner, not to the key that submitted it", async () => {
    const fixture = await openVideoApp();
    try {
      const owner = fixture.store.createUser({ email: "owner@example.com", name: "Owner", password: "password1" });
      const other = fixture.store.createUser({ email: "other@example.com", name: "Other", password: "password1" });
      const ownerKey = fixture.store.createApiKey("owner", owner.id).secret;
      const ownerSecondKey = fixture.store.createApiKey("owner-2", owner.id).secret;
      const otherKey = fixture.store.createApiKey("other", other.id).secret;
      fixture.store.saveVideoRequest({
        requestId: "vid-owned",
        connectionId: fixture.connectionId,
        providerId: "fake-video",
        modelId: MODEL,
        userId: owner.id,
        apiKeyId: null,
      });

      const stranger = await fixture.app.inject({
        method: "GET",
        url: "/v1/videos/vid-owned",
        headers: { authorization: `Bearer ${otherKey}` },
      });
      assert.equal(stranger.statusCode, 403);
      assert.deepEqual(stranger.json(), { error: { message: "forbidden", type: "viate_error" } });

      const unbound = await fixture.app.inject({
        method: "GET",
        url: "/v1/videos/vid-owned",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.equal(unbound.statusCode, 403);
      assert.equal(fixture.calls.length, 0);

      for (const secret of [ownerKey, ownerSecondKey]) {
        const allowed = await fixture.app.inject({
          method: "GET",
          url: "/v1/videos/vid-owned",
          headers: { authorization: `Bearer ${secret}` },
        });
        assert.equal(allowed.statusCode, 200);
      }
      assert.equal(fixture.calls.length, 2);
    } finally {
      await fixture.close();
    }
  });

  it("keeps an unbound job private to the key that submitted it", async () => {
    const fixture = await openVideoApp();
    try {
      await fixture.app.inject({
        method: "POST",
        url: "/v1/videos/generations",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: MODEL, prompt: "a lighthouse" },
      });
      const otherUnbound = fixture.store.createApiKey("second").secret;
      const response = await fixture.app.inject({
        method: "GET",
        url: "/v1/videos/vid-123",
        headers: { authorization: `Bearer ${otherUnbound}` },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(fixture.calls.length, 1);
    } finally {
      await fixture.close();
    }
  });
});

describe("video billing", () => {
  it("charges a per-request price once on submit and never on a poll", async () => {
    const fixture = await openVideoApp({
      modelPrices: {
        ready: true,
        lookup: (modelId) =>
          modelId === MODEL
            ? { inputNanoPerMillion: 0, outputNanoPerMillion: 0, perRequestNano: 250_000_000 }
            : null,
      },
    });
    try {
      const user = fixture.store.createUser({ email: "payer@example.com", name: "Payer", password: "password1" });
      fixture.store.grantUsd(user.id, "1.00");
      const secret = fixture.store.createApiKey("payer", user.id).secret;

      const submitted = await fixture.app.inject({
        method: "POST",
        url: "/v1/videos/generations",
        headers: { authorization: `Bearer ${secret}` },
        payload: { model: MODEL, prompt: "a lighthouse" },
      });
      assert.equal(submitted.statusCode, 200);
      await waitForBalanceNano(fixture.dataDir, user.id, 750_000_000);
      assert.equal(readInflight(fixture.dataDir, user.id), 0);
      assert.equal(fixture.store.getVideoRequest("vid-123")?.userId, user.id);

      const polled = await fixture.app.inject({
        method: "GET",
        url: "/v1/videos/vid-123",
        headers: { authorization: `Bearer ${secret}` },
      });
      assert.equal(polled.statusCode, 200);
      await settleTicks();
      assert.equal(readBalanceNano(fixture.dataDir, user.id), 750_000_000);
      assert.equal(readInflight(fixture.dataDir, user.id), 0);
      assert.equal(fixture.store.listLedger(user.id).filter((entry) => entry.reason === "usage").length, 1);
    } finally {
      await fixture.close();
    }
  });
});

type VideoFixture = {
  app: App;
  store: AdminStore;
  dataDir: string;
  secret: string;
  apiKeyId: string;
  connectionId: string;
  calls: ProviderCall[];
  close: () => Promise<void>;
};

async function openVideoApp(
  options: { provider?: ProviderHandler; modelPrices?: ModelPriceLookup } = {},
): Promise<VideoFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "viate-videos-"));
  const store = await AdminStore.open(dataDir);
  const created = store.createApiKey("videos");
  const connection = store.createConnection("fake-video");
  store.putCredentials(connection.id, { token: "k" }, "fake");
  store.setActive(connection.id, true);
  store.replaceConnectionModels(connection.id, [{ id: MODEL }]);
  const calls: ProviderCall[] = [];
  const app = await buildApp({
    logger: false,
    providers: [options.provider ?? videoProvider(calls)],
    store,
    modelPrices: options.modelPrices,
  });
  return {
    app,
    store,
    dataDir,
    secret: created.secret,
    apiKeyId: created.apiKey.id,
    connectionId: connection.id,
    calls,
    close: async () => {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function videoProvider(calls: ProviderCall[]): ProviderHandler {
  return {
    id: "fake-video",
    async videoGenerations(request, connection) {
      calls.push({ capability: "videoGenerations", body: request.body, connectionId: connection.connectionId });
      return jsonExchange({ request_id: "vid-123" });
    },
    async videoResult(request, connection) {
      calls.push({ capability: "videoResult", body: request.body, connectionId: connection.connectionId });
      return jsonExchange({
        request_id: "vid-123",
        status: "completed",
        video: { url: "https://videos.x.ai/vid-123.mp4" },
      });
    },
  };
}

function jsonExchange(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

async function settleTicks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

async function waitForBalanceNano(dataDir: string, userId: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (readBalanceNano(dataDir, userId) === expected) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  assert.equal(readBalanceNano(dataDir, userId), expected);
}

function readBalanceNano(dataDir: string, userId: string): number {
  return readUserColumn(dataDir, userId, "balance_nano");
}

function readInflight(dataDir: string, userId: string): number {
  return readUserColumn(dataDir, userId, "inflight");
}

function readUserColumn(dataDir: string, userId: string, column: "balance_nano" | "inflight"): number {
  const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
  try {
    const row = db.prepare(`SELECT ${column} AS value FROM users WHERE id = ?`).get(userId) as {
      value: number | bigint;
    };
    return Number(row.value);
  } finally {
    db.close();
  }
}
