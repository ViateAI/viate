import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProviderHandler } from "@viateai/sdk";
import { buildApp } from "./app.js";
import { multipartImageBody, redactImagePayload } from "./images.js";
import { AdminStore } from "./store.js";

describe("image request normalization", () => {
  it("inlines multipart files and leaves JSON fields intact", () => {
    const boundary = "viate-boundary";
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const raw = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngrok-imagine-image-2.0\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake a sketch\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n2\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="aspect_ratio"\r\n\r\n16:9\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="mask"; filename="mask.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      Buffer.from([0x01, 0x02]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    assert.deepEqual(multipartImageBody(`multipart/form-data; boundary=${boundary}`, raw), {
      model: "grok-imagine-image-2.0",
      prompt: "make a sketch",
      n: 2,
      aspect_ratio: "16:9",
      images: [{ b64_json: png.toString("base64"), media_type: "image/png" }],
      mask: { b64_json: Buffer.from([0x01, 0x02]).toString("base64"), media_type: "image/png" },
    });
  });

  it("redacts image bytes and data URIs but keeps ordinary URLs", () => {
    assert.deepEqual(
      redactImagePayload({
        prompt: "sketch",
        images: [{ b64_json: "abcdef", url: "data:image/png;base64,abcdef" }],
        reference: "https://example.com/a.png",
      }),
      {
        prompt: "sketch",
        images: [{ b64_json: "«6 chars»", url: "«28 chars»" }],
        reference: "https://example.com/a.png",
      },
    );
  });

  it("keeps SSE response bodies that start with data:", () => {
    const sse = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
    assert.equal(redactImagePayload(sse), sse);
    assert.equal(redactImagePayload("data:image/png;base64,abcdef"), "«28 chars»");
  });
});

describe("POST /v1/images", () => {
  it("rewrites a generation onto the provider and inlines an edit upload", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-images-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("images").secret;
    const created = store.createConnection("xai-oauth");
    store.putCredentials(created.id, { token: "k" }, "xai");
    store.setActive(created.id, true);
    store.replaceConnectionModels(created.id, [{ id: "grok-imagine-image-2.0" }]);
    const calls: Array<{ capability: string; body: unknown }> = [];
    const provider: ProviderHandler = {
      id: "xai-oauth",
      async imageGenerations(request) {
        calls.push({ capability: "imageGenerations", body: request.body });
        return { status: 200, headers: { "content-type": "application/json" }, body: jsonBody({ data: [{ url: "https://example.com/out.png" }] }) };
      },
      async imageEdits(request) {
        calls.push({ capability: "imageEdits", body: request.body });
        return { status: 200, headers: { "content-type": "application/json" }, body: jsonBody({ ok: true }) };
      },
    };
    const app = await buildApp({ logger: false, providers: [provider], store });
    try {
      const generated = await app.inject({
        method: "POST",
        url: "/v1/images/generations",
        headers: { authorization: `Bearer ${secret}` },
        payload: { model: "grok-imagine-image-2.0", prompt: "a lighthouse", size: "1024x1024" },
      });
      assert.equal(generated.statusCode, 200);
      assert.deepEqual(calls[0], {
        capability: "imageGenerations",
        body: { model: "grok-imagine-image-2.0", prompt: "a lighthouse", size: "1024x1024" },
      });

      const boundary = "viate-boundary";
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const edited = await app.inject({
        method: "POST",
        url: "/v1/images/edits",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngrok-imagine-image-2.0\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake a sketch\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          png,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(edited.statusCode, 200);
      assert.deepEqual(calls[1], {
        capability: "imageEdits",
        body: {
          model: "grok-imagine-image-2.0",
          prompt: "make a sketch",
          images: [{ b64_json: png.toString("base64"), media_type: "image/png" }],
        },
      });
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("returns 404 when the provider does not implement image generation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-images-missing-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("images").secret;
    const created = store.createConnection("xai-oauth");
    store.putCredentials(created.id, { token: "k" }, "xai");
    store.setActive(created.id, true);
    store.replaceConnectionModels(created.id, [{ id: "grok-imagine-image-2.0" }]);
    const app = await buildApp({
      logger: false,
      providers: [{ id: "xai-oauth", async chatCompletions() { return { status: 200, headers: {}, body: null }; } }],
      store,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/images/generations",
        headers: { authorization: `Bearer ${secret}` },
        payload: { model: "grok-imagine-image-2.0", prompt: "a lighthouse" },
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: { message: "capability not supported", type: "viate_error" } });
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

function jsonBody(value: unknown): ReadableStream<Uint8Array> {
  return new Response(JSON.stringify(value)).body as ReadableStream<Uint8Array>;
}
