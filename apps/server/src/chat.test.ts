import assert from "node:assert/strict";
import http from "node:http";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { JsonPostRequest, ProviderConnection, ProviderHandler } from "@viateai/sdk";
import { buildApp, type App } from "./app.js";
import { resetRoutingStateForTests } from "./routing.js";
import { AdminStore, type RequestLogRecord } from "./store.js";

describe("POST /v1/chat/completions", () => {
  let upstream: TestServer;
  let app: App;
  let store: AdminStore;
  let dataDir = "";
  let clientSecret = "";

  before(async () => {
    resetRoutingStateForTests();
    dataDir = await mkdtemp(join(tmpdir(), "viate-chat-"));
    store = await AdminStore.open(dataDir);
    clientSecret = store.createApiKey("tests").secret;
    upstream = await listen(async (req, res) => {
      const payload = JSON.parse((await readBody(req)) || "{}") as { stream?: boolean };
      if (req.headers.authorization !== "Bearer env-key") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unauthorized" } }));
        return;
      }
      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-local", choices: [{ message: { content: "ok" } }] }));
    });
    app = await buildApp({
      logger: false,
      providers: [passthroughProvider()],
      store,
    });
    enablePublished(store, { baseUrl: upstream.url, apiKey: "env-key" });
  });

  after(async () => {
    await app.close();
    await upstream.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("proxies a non-stream completion through the registered provider", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: bearer(clientSecret),
      payload: { model: "demo", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /application\/json/);
    assert.equal(response.json().id, "chatcmpl-local");
    const logged = await waitForRequestLog(store, "demo");
    assert.ok(logged.length >= 1);
    assert.equal(logged[0]?.endpoint, "chat.completions");
    assert.equal(logged[0]?.status, 200);
    assert.equal(logged[0]?.outcome, "success");
    assert.equal(logged[0]?.usageSource, "missing");
    assert.equal(logged[0]?.payloadTruncated, false);
    assert.ok(logged[0]?.payloadPath);
  });

  it("hides chat discovery without blocking /v1/chat/completions", async () => {
    store.setAdvertisedEndpointTypes("openai-compatible", ["openai-response"]);
    const models = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: bearer(clientSecret),
    });
    assert.equal(models.statusCode, 200);
    assert.deepEqual(models.json().data[0]?.supported_endpoint_types, ["openai-response"]);
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: bearer(clientSecret),
      payload: { model: "demo", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(chat.statusCode, 200);
    store.setAdvertisedEndpointTypes("openai-compatible", ["openai", "openai-response"]);
  });

  it("proxies an SSE stream through the registered provider", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: bearer(clientSecret),
      payload: { model: "demo", stream: true, messages: [] },
    });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /text\/event-stream/);
    assert.match(response.body, /data: \[DONE\]/);
  });

  it("propagates upstream errors", async () => {
    const isolatedDir = await mkdtemp(join(tmpdir(), "viate-chat-unauth-"));
    const isolated = await AdminStore.open(isolatedDir);
    const secret = isolated.createApiKey("tests").secret;
    enablePublished(isolated, { baseUrl: upstream.url, apiKey: "wrong" });
    const unauthorized = await buildApp({
      logger: false,
      providers: [passthroughProvider()],
      store: isolated,
    });
    try {
      const response = await unauthorized.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: { model: "demo", messages: [] },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.message, "unauthorized");
    } finally {
      await unauthorized.close();
      isolated.close();
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });

  it("returns 404 when the requested model is unpublished", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: bearer(clientSecret),
      payload: { model: "missing", messages: [] },
    });
    assert.equal(response.statusCode, 404);
    assert.match(response.json().error.message, /unknown model/);
  });

  it("aborts the upstream stream when the HTTP client disconnects after the first chunk", async () => {
    const { promise: upstreamAborted, resolve: resolveAborted } = Promise.withResolvers<void>();
    const hanging = await listen((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
      const markAborted = () => resolveAborted();
      req.on("aborted", markAborted);
      req.on("close", markAborted);
    });
    const isolatedDir = await mkdtemp(join(tmpdir(), "viate-chat-abort-"));
    const isolatedStore = await AdminStore.open(isolatedDir);
    const secret = isolatedStore.createApiKey("abort").secret;
    enablePublished(isolatedStore, { baseUrl: hanging.url, apiKey: "env-key" });
    const streaming = await buildApp({
      logger: false,
      providers: [passthroughProvider()],
      store: isolatedStore,
    });
    await streaming.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = streaming.server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected tcp address");
      }
      const { promise: firstChunk, resolve: gotChunk } = Promise.withResolvers<void>();
      const req = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        },
        (res) => {
          res.on("data", () => {
            gotChunk();
          });
        },
      );
      req.end(JSON.stringify({ model: "demo", stream: true, messages: [] }));
      await firstChunk;
      req.destroy();
      await upstreamAborted;
    } finally {
      await streaming.close();
      await hanging.close();
      isolatedStore.close();
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });
});

describe("POST /v1/chat/completions client auth", () => {
  it("rejects requests without a valid client API key", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-chat-auth-"));
    const store = await AdminStore.open(dataDir);
    const created = store.createApiKey("cli");
    const app = await buildApp({
      logger: false,
      providers: [passthroughProvider()],
      store,
    });
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "demo", messages: [] },
      });
      assert.equal(missing.statusCode, 401);
      assert.equal(missing.json().error.message, "invalid api key");

      const wrong = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer("viate_wrong"),
        payload: { model: "demo", messages: [] },
      });
      assert.equal(wrong.statusCode, 401);

      const viaHeader = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "x-api-key": created.secret },
        payload: { model: "demo", messages: [] },
      });
      assert.equal(viaHeader.statusCode, 404);
      assert.match(viaHeader.json().error.message, /unknown model/);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("core capability dispatcher", () => {
  it("dispatches models, embeddings, and responses with filtered headers", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-capabilities-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("capabilities").secret;
    const created = store.createConnection("all");
    store.putCredentials(created.id, { token: "k" }, "all");
    store.setActive(created.id, true);
    store.replaceConnectionModels(created.id, [{ id: "demo" }]);
    const calls: Array<{ capability: string; headers: Record<string, string>; body?: unknown }> = [];
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          controller.close();
        },
      });
    const provider: ProviderHandler = {
      id: "all",
      async embeddings(request) {
        calls.push({ capability: "embeddings", headers: request.headers });
        return {
          status: 201,
          headers: { "cache-control": "no-store", "x-private": "no" },
          body: body(),
        };
      },
      async responses(request) {
        calls.push({ capability: "responses", headers: request.headers });
        return {
          status: 202,
          headers: { "content-type": "application/json", "x-private": "no" },
          body: body(),
        };
      },
      async responsesCompact(request) {
        calls.push({ capability: "responsesCompact", headers: request.headers, body: request.body });
        return {
          status: 203,
          headers: { "content-type": "application/json", "x-private": "no" },
          body: body(),
        };
      },
    };
    const app = await buildApp({
      logger: false,
      providers: [provider],
      store,
    });
    try {
      const models = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { ...bearer(secret), "openai-beta": "assistants=v2", "x-private": "no" },
      });
      assert.equal(models.statusCode, 200);
      assert.equal(models.headers["x-private"], undefined);
      assert.deepEqual(models.json(), {
        object: "list",
        data: [
          {
            id: "demo",
            object: "model",
            owned_by: "all",
            supported_endpoint_types: ["openai", "openai-response"],
          },
        ],
      });
      assert.equal(calls.length, 0);

      const embeddings = await app.inject({
        method: "POST",
        url: "/v1/embeddings",
        headers: { ...bearer(secret), "anthropic-version": "2023-06-01" },
        payload: { model: "demo", input: "hello" },
      });
      assert.equal(embeddings.statusCode, 201);
      assert.equal(embeddings.headers["cache-control"], "no-store");
      assert.equal(embeddings.headers["x-private"], undefined);
      assert.deepEqual(calls[0], {
        capability: "embeddings",
        headers: { "anthropic-version": "2023-06-01" },
      });

      const responses = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { ...bearer(secret), "openai-beta": "assistants=v2" },
        payload: { model: "demo", input: "hello" },
      });
      assert.equal(responses.statusCode, 202);
      assert.equal(responses.headers["content-type"], "application/json");
      assert.equal(responses.headers["x-private"], undefined);
      assert.deepEqual(calls[1], {
        capability: "responses",
        headers: { "openai-beta": "assistants=v2" },
      });

      const compact = await app.inject({
        method: "POST",
        url: "/v1/responses/compact",
        headers: { ...bearer(secret), "openai-beta": "assistants=v2" },
        payload: { model: "demo", input: "hello", stream: false, include: ["reasoning.encrypted_content"] },
      });
      assert.equal(compact.statusCode, 203);
      assert.equal(compact.headers["content-type"], "application/json");
      assert.equal(compact.headers["x-private"], undefined);
      assert.deepEqual(calls[2], {
        capability: "responsesCompact",
        headers: { "openai-beta": "assistants=v2" },
        body: { model: "demo", input: "hello", stream: false, include: ["reasoning.encrypted_content"] },
      });
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("returns 404 when the provider does not implement responsesCompact", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-compact-missing-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("compact").secret;
    const created = store.createConnection("all");
    store.putCredentials(created.id, { token: "k" }, "all");
    store.setActive(created.id, true);
    store.replaceConnectionModels(created.id, [{ id: "demo" }]);
    const app = await buildApp({
      logger: false,
      providers: [{
        id: "all",
        async responses() {
          return { status: 200, headers: {}, body: null };
        },
      }],
      store,
    });
    try {
      const compact = await app.inject({
        method: "POST",
        url: "/v1/responses/compact",
        headers: bearer(secret),
        payload: { model: "demo", input: "hello" },
      });
      assert.equal(compact.statusCode, 404);
      assert.deepEqual(compact.json(), {
        error: { message: "capability not supported", type: "viate_error" },
      });
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("answers POST /v1/responses/compact over a real HTTP listener", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-compact-http-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("compact-http").secret;
    const created = store.createConnection("all");
    store.putCredentials(created.id, { token: "k" }, "all");
    store.setActive(created.id, true);
    store.replaceConnectionModels(created.id, [{ id: "demo" }]);
    const app = await buildApp({
      logger: false,
      providers: [{
        id: "all",
        async responsesCompact() {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: new Response(JSON.stringify({ id: "resp_compact", object: "response" })).body,
          };
        },
      }],
      store,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected tcp address");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses/compact`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "demo", input: "hello" }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.deepEqual(await response.json(), { id: "resp_compact", object: "response" });
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("returns 200 empty list when no models are published", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-empty-catalog-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("empty").secret;
    const app = await buildApp({
      logger: false,
      providers: [{ id: "openai-compatible" }],
      store,
    });
    try {
      const models = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: bearer(secret),
      });
      assert.equal(models.statusCode, 200);
      assert.deepEqual(models.json(), { object: "list", data: [] });
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("aggregates the same id and omits pin ids from data", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-agg-catalog-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("agg").secret;
    const openaiA = store.createConnection("openai-compatible");
    const openaiB = store.createConnection("openai-compatible");
    const anthropic = store.createConnection("anthropic");
    store.putCredentials(openaiA.id, { token: "a" }, "a");
    store.putCredentials(openaiB.id, { token: "b" }, "b");
    store.putCredentials(anthropic.id, { token: "c" }, "c");
    store.replaceConnectionModels(openaiA.id, [{ id: "gpt-4o" }]);
    store.replaceConnectionModels(openaiB.id, [{ id: "gpt-4o" }]);
    store.replaceConnectionModels(anthropic.id, [{ id: "gpt-4o" }]);
    store.setActive(openaiA.id, true);
    store.setActive(openaiB.id, true);
    const app = await buildApp({
      logger: false,
      providers: [{ id: "openai-compatible" }, { id: "anthropic" }],
      store,
    });
    try {
      const sameProvider = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: bearer(secret),
      });
      assert.deepEqual(sameProvider.json(), {
        object: "list",
        data: [
          {
            id: "gpt-4o",
            object: "model",
            owned_by: "openai-compatible",
            supported_endpoint_types: ["openai", "openai-response"],
          },
        ],
      });
      store.setActive(anthropic.id, true);
      const both = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: bearer(secret),
      });
      const payload = both.json() as {
        data: Array<{ id: string; owned_by: string; children?: Array<{ id: string }> }>;
      };
      assert.equal(payload.data.length, 1);
      assert.equal(payload.data[0]?.id, "gpt-4o");
      assert.equal(payload.data[0]?.owned_by, "viate");
      assert.deepEqual(
        payload.data[0]?.children?.map((child) => child.id),
        ["openai-compatible/gpt-4o", "anthropic/gpt-4o"],
      );
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("excludes disabled models, disabled connections, and needs_reauth", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-exclude-catalog-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("exclude").secret;
    const disabledConn = store.createConnection("openai-compatible");
    const reauth = store.createConnection("openai-compatible");
    const enabled = store.createConnection("openai-compatible");
    store.putCredentials(disabledConn.id, { token: "a" }, "off");
    store.putCredentials(reauth.id, { token: "b" }, "reauth");
    store.putCredentials(enabled.id, { token: "c" }, "on");
    store.replaceConnectionModels(disabledConn.id, [{ id: "hidden-conn" }]);
    store.replaceConnectionModels(reauth.id, [{ id: "reauth-model" }]);
    store.replaceConnectionModels(enabled.id, [{ id: "keep" }, { id: "off" }]);
    store.setConnectionModelEnabled(enabled.id, "off", false);
    store.setActive(reauth.id, true);
    store.setActive(enabled.id, true);
    store.setKeepalive(reauth.id, "needs_reauth", "expired");
    const app = await buildApp({
      logger: false,
      providers: [{ id: "openai-compatible" }],
      store,
    });
    try {
      const models = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: bearer(secret),
      });
      assert.deepEqual(models.json(), {
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
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rewrites chat model to the upstream id and failovers retryable errors", async () => {
    resetRoutingStateForTests();
    const dataDir = await mkdtemp(join(tmpdir(), "viate-failover-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("failover").secret;
    const openai = store.createConnection("openai-compatible");
    const anthropic = store.createConnection("anthropic");
    store.putCredentials(openai.id, { token: "o" }, "openai");
    store.putCredentials(anthropic.id, { token: "a" }, "anthropic");
    store.replaceConnectionModels(openai.id, [{ id: "gpt-4o" }]);
    store.replaceConnectionModels(anthropic.id, [{ id: "gpt-4o" }]);
    store.setActive(openai.id, true);
    store.setActive(anthropic.id, true);
    const seen: Array<{ providerId: string; model: unknown; connectionId: string }> = [];
    const json = (status: number) => ({
      status,
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"ok":${status}}`));
          controller.close();
        },
      }),
    });
    const app = await buildApp({
      logger: false,
      store,
      providers: [
        {
          id: "openai-compatible",
          async chatCompletions(request, connection) {
            seen.push({
              providerId: "openai-compatible",
              model: (request.body as { model?: unknown }).model,
              connectionId: connection.connectionId,
            });
            return json(429);
          },
        },
        {
          id: "anthropic",
          async chatCompletions(request, connection) {
            seen.push({
              providerId: "anthropic",
              model: (request.body as { model?: unknown }).model,
              connectionId: connection.connectionId,
            });
            return json(200);
          },
        },
      ],
    });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: { model: "gpt-4o", messages: [{ role: "user", content: "cache-me" }] },
      });
      assert.equal(first.statusCode, 200);
      assert.deepEqual(
        seen.map((item) => item.providerId),
        ["openai-compatible", "anthropic"],
      );
      assert.equal(seen.every((item) => item.model === "gpt-4o"), true);

      seen.length = 0;
      const sticky = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: { model: "gpt-4o", messages: [{ role: "user", content: "cache-me" }] },
      });
      assert.equal(sticky.statusCode, 200);
      assert.deepEqual(
        seen.map((item) => item.providerId),
        ["anthropic"],
      );

      seen.length = 0;
      const pinned = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: { model: "openai-compatible/gpt-4o", messages: [{ role: "user", content: "pin" }] },
      });
      assert.equal(pinned.statusCode, 429);
      assert.deepEqual(
        seen.map((item) => item.providerId),
        ["openai-compatible"],
      );
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not failover HTTP 400", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-no-failover-400-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("no400").secret;
    const openai = store.createConnection("openai-compatible");
    const anthropic = store.createConnection("anthropic");
    store.putCredentials(openai.id, { token: "o" }, "openai");
    store.putCredentials(anthropic.id, { token: "a" }, "anthropic");
    store.replaceConnectionModels(openai.id, [{ id: "gpt-4o" }]);
    store.replaceConnectionModels(anthropic.id, [{ id: "gpt-4o" }]);
    store.setActive(openai.id, true);
    store.setActive(anthropic.id, true);
    let second = 0;
    const json = (status: number) => ({
      status,
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }),
    });
    const app = await buildApp({
      logger: false,
      store,
      providers: [
        { id: "openai-compatible", async chatCompletions() { return json(400); } },
        { id: "anthropic", async chatCompletions() { second += 1; return json(200); } },
      ],
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: { model: "gpt-4o", messages: [] },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(second, 0);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("uses admin provider order when no sticky or LKGP exists", async () => {
    resetRoutingStateForTests();
    const dataDir = await mkdtemp(join(tmpdir(), "viate-order-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("order").secret;
    const openai = store.createConnection("openai-compatible");
    const anthropic = store.createConnection("anthropic");
    store.putCredentials(openai.id, { token: "o" }, "openai");
    store.putCredentials(anthropic.id, { token: "a" }, "anthropic");
    store.replaceConnectionModels(openai.id, [{ id: "gpt-4o" }]);
    store.replaceConnectionModels(anthropic.id, [{ id: "gpt-4o" }]);
    store.setActive(openai.id, true);
    store.setActive(anthropic.id, true);
    store.setPublishedModelProviders("gpt-4o", ["anthropic", "openai-compatible"]);
    const seen: string[] = [];
    const json = (status: number) => ({
      status,
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }),
    });
    const app = await buildApp({
      logger: false,
      store,
      providers: [
        { id: "openai-compatible", async chatCompletions() { seen.push("openai-compatible"); return json(200); } },
        { id: "anthropic", async chatCompletions() { seen.push("anthropic"); return json(200); } },
      ],
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: { model: "gpt-4o", messages: [{ role: "user", content: "unique-order" }] },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(seen, ["anthropic"]);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("failovers upstream 403 to another connection", async () => {
    resetRoutingStateForTests();
    const dataDir = await mkdtemp(join(tmpdir(), "viate-failover-403-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("failover403").secret;
    const openai = store.createConnection("openai-compatible");
    const anthropic = store.createConnection("anthropic");
    store.putCredentials(openai.id, { token: "o" }, "openai");
    store.putCredentials(anthropic.id, { token: "a" }, "anthropic");
    store.replaceConnectionModels(openai.id, [{ id: "gpt-4o" }]);
    store.replaceConnectionModels(anthropic.id, [{ id: "gpt-4o" }]);
    store.setActive(openai.id, true);
    store.setActive(anthropic.id, true);
    const seen: string[] = [];
    const json = (status: number) => ({
      status,
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"ok":${status}}`));
          controller.close();
        },
      }),
    });
    const app = await buildApp({
      logger: false,
      store,
      providers: [
        { id: "openai-compatible", async chatCompletions() { seen.push("openai-compatible"); return json(403); } },
        { id: "anthropic", async chatCompletions() { seen.push("anthropic"); return json(200); } },
      ],
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: { model: "gpt-4o", messages: [{ role: "user", content: "auth-miss" }] },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(seen, ["openai-compatible", "anthropic"]);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("maps missing model to 400 and provider throw after exhausting the pool to 503", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-capability-errors-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("errors").secret;
    const created = store.createConnection("throws");
    store.putCredentials(created.id, {});
    store.setActive(created.id, true);
    store.replaceConnectionModels(created.id, [{ id: "demo" }]);
    const app = await buildApp({
      logger: false,
      store,
      providers: [{ id: "throws", async chatCompletions() { throw new Error("provider exploded"); } }],
    });
    try {
      const missingModel = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: {},
      });
      assert.equal(missingModel.statusCode, 400);

      const thrown = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: { model: "demo", messages: [] },
      });
      assert.equal(thrown.statusCode, 503);
      assert.match(thrown.json().error.message, /provider exploded/);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("runs provider keepalive once at startup and persists status", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-keepalive-"));
    const store = await AdminStore.open(dataDir);
    const stored = store.createConnection("refreshing");
    store.putCredentials(stored.id, { refreshToken: "old" });
    let calls = 0;
    const app = await buildApp({
      logger: false,
      providers: [{
        id: "refreshing",
        async keepalive(input) {
          calls += 1;
          assert.equal(input.reason, "timer");
          assert.deepEqual(input.credentials, { refreshToken: "old" });
          assert.equal(typeof input.log.warn, "function");
          return {
            status: "ok",
            credentials: { refreshToken: "new" },
            displayLabel: "refreshed",
          };
        },
      }],
      store,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.deepEqual(store.getCredentials(stored.id), { refreshToken: "new" });
      assert.equal(store.getConnection(stored.id)?.displayLabel, "refreshed");
      assert.equal(store.getConnection(stored.id)?.keepaliveStatus, "ok");
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("replaces the previous keepalive timer instead of stacking", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dataDir = await mkdtemp(join(tmpdir(), "viate-keepalive-stack-"));
    const store = await AdminStore.open(dataDir);
    const stored = store.createConnection("refreshing");
    store.putCredentials(stored.id, {});
    let calls = 0;
    const app = await buildApp({
      logger: false,
      providers: [{
        id: "refreshing",
        async keepalive() {
          calls += 1;
          return { status: "ok", nextDueMs: 25 };
        },
      }],
      store,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      t.mock.timers.tick(25);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
      t.mock.timers.tick(24);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
      t.mock.timers.tick(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 3);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not block app startup on keepalive", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-keepalive-startup-"));
    const store = await AdminStore.open(dataDir);
    const stored = store.createConnection("hanging");
    store.putCredentials(stored.id, {});
    const pending = new Promise<never>(() => {});
    const app = await buildApp({
      logger: false,
      providers: [{ id: "hanging", keepalive: () => pending }],
      store,
    });
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("logs keepalive needs_reauth and thrown failures", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-keepalive-logs-"));
    const store = await AdminStore.open(dataDir);
    const reauth = store.createConnection("grok");
    store.putCredentials(reauth.id, { refreshToken: "old" });
    const exploding = store.createConnection("codex");
    store.putCredentials(exploding.id, { refreshToken: "old" });
    const lines: string[] = [];
    const app = await buildApp({
      logger: {
        level: "warn",
        stream: new Writable({
          write(chunk, _encoding, callback) {
            lines.push(String(chunk));
            callback();
          },
        }),
      },
      providers: [
        {
          id: "grok",
          async keepalive() {
            return {
              status: "needs_reauth",
              error: "Grok token refresh failed (400): Refresh token has been revoked",
            };
          },
        },
        {
          id: "codex",
          async keepalive() {
            throw new Error("network down");
          },
        },
      ],
      store,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const parsed = lines.map((line) => JSON.parse(line) as {
        msg?: string;
        connectionId?: string;
        providerId?: string;
        status?: string;
        error?: string;
        err?: { message?: string };
      });
      const reauthLog = parsed.find((line) => line.connectionId === reauth.id);
      const thrownLog = parsed.find((line) => line.connectionId === exploding.id);
      assert.equal(reauthLog?.msg, "keepalive failed");
      assert.equal(reauthLog?.providerId, "grok");
      assert.equal(reauthLog?.status, "needs_reauth");
      assert.equal(
        reauthLog?.error,
        "Grok token refresh failed (400): Refresh token has been revoked",
      );
      assert.equal(thrownLog?.msg, "keepalive failed");
      assert.equal(thrownLog?.providerId, "codex");
      assert.equal(thrownLog?.status, "failed");
      assert.equal(thrownLog?.error, "network down");
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("retries keepalive after a thrown failure", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dataDir = await mkdtemp(join(tmpdir(), "viate-keepalive-backoff-"));
    const store = await AdminStore.open(dataDir);
    const stored = store.createConnection("refreshing");
    store.putCredentials(stored.id, { refreshToken: "old" });
    let calls = 0;
    const app = await buildApp({
      logger: false,
      providers: [{
        id: "refreshing",
        async keepalive() {
          calls += 1;
          if (calls === 1) {
            throw new Error("network down");
          }
          return { status: "ok", nextDueMs: 60_000 };
        },
      }],
      store,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.equal(store.getConnection(stored.id)?.keepaliveStatus, "failed");
      t.mock.timers.tick(59_999);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      t.mock.timers.tick(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
      assert.equal(store.getConnection(stored.id)?.keepaliveStatus, "ok");
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not retry keepalive after needs_reauth", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const dataDir = await mkdtemp(join(tmpdir(), "viate-keepalive-reauth-"));
    const store = await AdminStore.open(dataDir);
    const stored = store.createConnection("refreshing");
    store.putCredentials(stored.id, { refreshToken: "old" });
    let calls = 0;
    const app = await buildApp({
      logger: false,
      providers: [{
        id: "refreshing",
        async keepalive() {
          calls += 1;
          return { status: "needs_reauth", error: "revoked" };
        },
      }],
      store,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      t.mock.timers.tick(5 * 60_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reruns keepalive when credentials are replaced", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-keepalive-creds-"));
    const store = await AdminStore.open(dataDir);
    const stored = store.createConnection("refreshing");
    store.putCredentials(stored.id, { refreshToken: "old" });
    let calls = 0;
    const seen: unknown[] = [];
    const app = await buildApp({
      logger: false,
      providers: [{
        id: "refreshing",
        async keepalive(input) {
          calls += 1;
          seen.push(input.credentials);
          return { status: "ok", nextDueMs: 60_000 };
        },
      }],
      store,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.deepEqual(seen, [{ refreshToken: "old" }]);
      store.putCredentials(stored.id, { refreshToken: "new" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
      assert.deepEqual(seen, [{ refreshToken: "old" }, { refreshToken: "new" }]);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("watchdog reruns keepalive when no timer is scheduled", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const dataDir = await mkdtemp(join(tmpdir(), "viate-keepalive-watchdog-"));
    const store = await AdminStore.open(dataDir);
    const stored = store.createConnection("refreshing");
    store.putCredentials(stored.id, { refreshToken: "old" });
    let calls = 0;
    const app = await buildApp({
      logger: false,
      providers: [{
        id: "refreshing",
        async keepalive() {
          calls += 1;
          return { status: "ok" };
        },
      }],
      store,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      t.mock.timers.tick(5 * 60_000 - 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      t.mock.timers.tick(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("nudges keepalive with reason request after upstream 403", async () => {
    resetRoutingStateForTests();
    const dataDir = await mkdtemp(join(tmpdir(), "viate-keepalive-403-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("authfail").secret;
    const openai = store.createConnection("openai-compatible");
    const anthropic = store.createConnection("anthropic");
    store.putCredentials(openai.id, { token: "o" }, "openai");
    store.putCredentials(anthropic.id, { token: "a" }, "anthropic");
    store.replaceConnectionModels(openai.id, [{ id: "gpt-4o" }]);
    store.replaceConnectionModels(anthropic.id, [{ id: "gpt-4o" }]);
    store.setActive(openai.id, true);
    store.setActive(anthropic.id, true);
    const reasons: string[] = [];
    const json = (status: number) => ({
      status,
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }),
    });
    const app = await buildApp({
      logger: false,
      store,
      providers: [
        {
          id: "openai-compatible",
          async keepalive(input) {
            reasons.push(input.reason);
            return { status: "ok", nextDueMs: 60_000 };
          },
          async chatCompletions() {
            return json(403);
          },
        },
        {
          id: "anthropic",
          async chatCompletions() {
            return json(200);
          },
        },
      ],
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(reasons, ["timer"]);
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: bearer(secret),
        payload: { model: "gpt-4o", messages: [{ role: "user", content: "auth-miss" }] },
      });
      assert.equal(response.statusCode, 200);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(reasons, ["timer", "request"]);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

async function waitForRequestLog(store: AdminStore, model: string): Promise<RequestLogRecord[]> {
  for (let i = 0; i < 20; i += 1) {
    const logged = store.listRequestLogs({ model });
    if (logged.length > 0) {
      return logged;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return store.listRequestLogs({ model });
}

function enablePublished(
  store: AdminStore,
  credentials: { baseUrl: string; apiKey: string },
  modelId = "demo",
): void {
  const created = store.createConnection("openai-compatible");
  store.putCredentials(created.id, credentials, "primary");
  store.setActive(created.id, true);
  store.replaceConnectionModels(created.id, [{ id: modelId }]);
}

function passthroughProvider(): ProviderHandler {
  return {
    id: "openai-compatible",
    async chatCompletions(request: JsonPostRequest, providerConnection: ProviderConnection) {
      const credentials = providerConnection.credentials as { baseUrl: string; apiKey?: string };
      const url = `${credentials.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (credentials.apiKey) {
        headers.authorization = `Bearer ${credentials.apiKey}`;
      }
      const upstream = await fetch(url, {
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
      };
    },
  };
}

type TestServer = {
  url: string;
  close(): Promise<void>;
};

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<TestServer> {
  const { promise, resolve, reject } = Promise.withResolvers<TestServer>();
  const server: Server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
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

function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
  return promise;
}
