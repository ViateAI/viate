import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProviderHandler } from "@viateai/sdk";
import { multipartAudioBody } from "./audio.js";
import { buildApp, type App } from "./app.js";
import { readRequestPayload } from "./request-logs.js";
import { resetRoutingStateForTests } from "./routing.js";
import { AdminStore, type RequestLogRecord } from "./store.js";

describe("audio request normalization", () => {
  it("inlines the audio file with model, language, and other text fields", () => {
    const boundary = "viate-audio";
    const wav = Buffer.from("RIFF-audio-bytes");
    const raw = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nnote\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    assert.deepEqual(multipartAudioBody(`multipart/form-data; boundary=${boundary}`, raw), {
      model: "whisper-1",
      language: "en",
      prompt: "note",
      response_format: "json",
      file: { b64_json: wav.toString("base64"), media_type: "audio/wav" },
    });
  });
});

describe("POST /v1/audio", () => {
  it("rejects missing, invalid, cookie, and unprovisioned client auth", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-audio-auth-"));
    const store = await AdminStore.open(dataDir);
    const created = store.createApiKey("audio");
    const app = await buildApp({ logger: false, providers: [], store });
    const emptyDir = await mkdtemp(join(tmpdir(), "viate-audio-nokeys-"));
    const emptyStore = await AdminStore.open(emptyDir);
    const emptyApp = await buildApp({ logger: false, providers: [], store: emptyStore });
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        payload: { model: "tts-1", input: "hi", voice: "alloy" },
      });
      assert.equal(missing.statusCode, 401);
      assert.equal(missing.json().error.message, "invalid api key");

      const wrong = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: { authorization: "Bearer viate_wrong" },
        payload: { model: "whisper-1" },
      });
      assert.equal(wrong.statusCode, 401);

      const cookie = await app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { cookie: "viate_admin=not-a-client-key" },
        payload: { model: "tts-1", input: "hi", voice: "alloy" },
      });
      assert.equal(cookie.statusCode, 401);
      assert.equal(cookie.json().error.message, "invalid api key");

      const viaHeader = await app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { "x-api-key": created.secret },
        payload: { model: "missing-model", input: "hi", voice: "alloy" },
      });
      assert.equal(viaHeader.statusCode, 404);
      assert.match(viaHeader.json().error.message, /unknown model/);

      const noKeys = await emptyApp.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { authorization: `Bearer ${created.secret}` },
        payload: { model: "tts-1", input: "hi", voice: "alloy" },
      });
      assert.equal(noKeys.statusCode, 401);
    } finally {
      await app.close();
      await emptyApp.close();
      store.close();
      emptyStore.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("returns 400 for missing file, model, input, or voice", async () => {
    const fixture = await openAudioApp();
    try {
      const missingModel = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { input: "hi", voice: "alloy" },
      });
      assert.equal(missingModel.statusCode, 400);
      assert.equal(missingModel.json().error.message, "model is required");

      const missingInput = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: "tts-1", voice: "alloy" },
      });
      assert.equal(missingInput.statusCode, 400);
      assert.equal(missingInput.json().error.message, "input is required");

      const missingVoice = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: "tts-1", input: "hi" },
      });
      assert.equal(missingVoice.statusCode, 400);
      assert.equal(missingVoice.json().error.message, "voice is required");

      const boundary = "viate-audio";
      const missingFile = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: {
          authorization: `Bearer ${fixture.secret}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
            `--${boundary}--\r\n`,
        ),
      });
      assert.equal(missingFile.statusCode, 400);
      assert.equal(missingFile.json().error.message, "file is required");

      const wav = Buffer.from("RIFF-audio-bytes");
      const missingTranscriptionModel = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: {
          authorization: `Bearer ${fixture.secret}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
          ),
          wav,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(missingTranscriptionModel.statusCode, 400);
      assert.equal(missingTranscriptionModel.json().error.message, "model is required");
    } finally {
      await fixture.close();
    }
  });

  it("returns 404 when the provider does not implement speech", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-audio-missing-cap-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("audio").secret;
    const created = store.createConnection("fake-audio");
    store.putCredentials(created.id, { token: "k" }, "fake");
    store.setActive(created.id, true);
    store.replaceConnectionModels(created.id, [{ id: "tts-1" }]);
    const app = await buildApp({
      logger: false,
      providers: [{ id: "fake-audio", async chatCompletions() { return { status: 200, headers: {}, body: null }; } }],
      store,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { authorization: `Bearer ${secret}` },
        payload: { model: "tts-1", input: "hi", voice: "alloy" },
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: { message: "capability not supported", type: "viate_error" } });
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("routes speech and transcriptions through the model connection", async () => {
    resetRoutingStateForTests();
    const wav = Buffer.from("RIFF-audio-bytes");
    const speech = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.from("ID3smoke")]);
    const calls: Array<{ capability: string; body: unknown }> = [];
    const fixture = await openAudioApp({
      async audioTranscriptions(request) {
        calls.push({ capability: "audioTranscriptions", body: request.body });
        const body = request.body;
        const format =
          body && typeof body === "object" && "response_format" in body && typeof body.response_format === "string"
            ? body.response_format
            : undefined;
        if (format === "text") {
          return {
            status: 200,
            headers: { "content-type": "text/plain" },
            body: bytesBody(Buffer.from("plain transcript")),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: bytesBody(Buffer.from(JSON.stringify({ text: "transcribed words" }))),
        };
      },
      async audioSpeech(request) {
        calls.push({ capability: "audioSpeech", body: request.body });
        return { status: 200, headers: { "content-type": "audio/mpeg" }, body: bytesBody(speech) };
      },
    });
    try {
      const boundary = "viate-audio";
      const transcribed = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: {
          authorization: `Bearer ${fixture.secret}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nnote\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
          ),
          wav,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(transcribed.statusCode, 200);
      assert.match(String(transcribed.headers["content-type"]), /^application\/json/);
      assert.deepEqual(transcribed.json(), { text: "transcribed words" });
      assert.deepEqual(calls[0], {
        capability: "audioTranscriptions",
        body: {
          model: "whisper-1",
          language: "en",
          prompt: "note",
          file: { b64_json: wav.toString("base64"), media_type: "audio/wav" },
        },
      });
      const transcriptionLog = await waitForPayload(fixture.store, fixture.dataDir, "whisper-1");
      assert.equal(transcriptionLog.row.endpoint, "audio.transcriptions");
      const transcriptionLogged = JSON.stringify(transcriptionLog.payload);
      assert.equal(transcriptionLogged.includes(wav.toString("base64")), false);
      assert.equal(transcriptionLogged.includes("RIFF-audio-bytes"), false);
      assert.deepEqual(transcriptionLog.payload.request, {
        model: "whisper-1",
        language: "en",
        prompt: "note",
        file: { b64_json: `«${wav.toString("base64").length} chars»`, media_type: "audio/wav" },
      });
      assert.deepEqual(transcriptionLog.payload.response, {
        status: 200,
        body: { text: "transcribed words" },
      });

      const spoken = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: "tts-1", input: "hello there", voice: "alloy", response_format: "mp3", speed: 1.25 },
      });
      assert.equal(spoken.statusCode, 200);
      assert.match(String(spoken.headers["content-type"]), /^audio\/mpeg/);
      assert.deepEqual(Buffer.from(spoken.rawPayload), speech);
      assert.deepEqual(calls[1], {
        capability: "audioSpeech",
        body: { model: "tts-1", input: "hello there", voice: "alloy", response_format: "mp3", speed: 1.25 },
      });
      const speechLog = await waitForPayload(fixture.store, fixture.dataDir, "tts-1");
      assert.equal(speechLog.row.endpoint, "audio.speech");
      const speechLogged = JSON.stringify(speechLog.payload);
      assert.equal(speechLogged.includes("ID3smoke"), false);
      assert.match(speechLogged, /«\d+ bytes»/);
      assert.deepEqual(speechLog.payload.request, {
        model: "tts-1",
        input: "hello there",
        voice: "alloy",
        response_format: "mp3",
        speed: 1.25,
      });

      const plain = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: {
          authorization: `Bearer ${fixture.secret}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
          ),
          wav,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(plain.statusCode, 200);
      assert.match(String(plain.headers["content-type"]), /^text\/plain/);
      assert.equal(Buffer.from(plain.rawPayload).toString("utf8"), "plain transcript");

      const unknown = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: "missing-model", input: "hi", voice: "alloy" },
      });
      assert.equal(unknown.statusCode, 404);
      assert.match(unknown.json().error.message, /unknown model/);
    } finally {
      await fixture.close();
    }
  });

  it("routes a custom transcription model the provider catalog does not list", async () => {
    resetRoutingStateForTests();
    const dataDir = await mkdtemp(join(tmpdir(), "viate-audio-custom-"));
    const store = await AdminStore.open(dataDir);
    const secret = store.createApiKey("audio").secret;
    const created = store.createConnection("xai-oauth");
    store.putCredentials(created.id, { token: "k" }, "xai");
    store.setActive(created.id, true);
    const calls: string[] = [];
    const provider: ProviderHandler = {
      id: "xai-oauth",
      async audioTranscriptions(request) {
        const body = request.body;
        calls.push(body && typeof body === "object" && "model" in body && typeof body.model === "string" ? body.model : "");
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: bytesBody(Buffer.from(JSON.stringify({ text: "heard" }))),
        };
      },
    };
    const app = await buildApp({ logger: false, providers: [provider], store });
    const boundary = "viate-custom";
    const wav = Buffer.from("RIFF-audio-bytes");
    const payload = () => Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngrok-voice-transcribe-2.0\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      ),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: payload(),
      });
      assert.equal(missing.statusCode, 404);
      assert.match(missing.json().error.message, /unknown model/);
      assert.equal(calls.length, 0);

      const before = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${secret}` },
      });
      assert.equal(before.json().data.some((model: { id: string }) => model.id === "grok-voice-transcribe-2.0"), false);

      store.addConnectionModel(created.id, {
        id: "grok-voice-transcribe-2.0",
        endpointTypes: ["openai-audio"],
      });

      const listed = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${secret}` },
      });
      assert.equal(listed.statusCode, 200);
      const voice = listed.json().data.find((model: { id: string }) => model.id === "grok-voice-transcribe-2.0");
      assert.deepEqual(voice?.supported_endpoint_types, ["openai-audio"]);

      const hit = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: payload(),
      });
      assert.equal(hit.statusCode, 200);
      assert.deepEqual(hit.json(), { text: "heard" });
      assert.deepEqual(calls, ["grok-voice-transcribe-2.0"]);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

type AudioFixture = {
  app: App;
  store: AdminStore;
  dataDir: string;
  secret: string;
  close: () => Promise<void>;
};

async function openAudioApp(methods: Partial<ProviderHandler> = {}): Promise<AudioFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "viate-audio-"));
  const store = await AdminStore.open(dataDir);
  const secret = store.createApiKey("audio").secret;
  const created = store.createConnection("fake-audio");
  store.putCredentials(created.id, { token: "k" }, "fake");
  store.setActive(created.id, true);
  store.replaceConnectionModels(created.id, [{ id: "whisper-1" }, { id: "tts-1" }]);
  const provider: ProviderHandler = { id: "fake-audio", ...methods };
  const app = await buildApp({ logger: false, providers: [provider], store });
  return {
    app,
    store,
    dataDir,
    secret,
    close: async () => {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function bytesBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function waitForPayload(
  store: AdminStore,
  dataDir: string,
  model: string,
): Promise<{ row: RequestLogRecord; payload: { request: unknown; response: unknown } }> {
  for (let i = 0; i < 40; i += 1) {
    const row = store.listRequestLogs({ model }).find((item) => item.payloadPath);
    if (row?.payloadPath) {
      const payload = await readRequestPayload(dataDir, row.payloadPath, row.payloadOffset);
      if (payload) {
        return { row, payload };
      }
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  throw new Error(`missing request log for ${model}`);
}
