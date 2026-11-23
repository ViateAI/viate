import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { RequestLogRecorder, clientErrorMessage, readRequestPayload, redactLogError } from "./request-logs.js";
import { AdminStore } from "./store.js";

describe("RequestLogRecorder", () => {
  let dataDir = "";
  let store: AdminStore;
  let recorder: RequestLogRecorder;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-recorder-"));
    store = await AdminStore.open(dataDir);
    recorder = new RequestLogRecorder(store, { logPayloads: true });
  });

  after(async () => {
    await recorder.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("writes sqlite metadata and a daily jsonl payload line", async () => {
    recorder.record({
      id: "req-jsonl-1",
      startedAt: Date.now() - 15,
      endedAt: Date.now(),
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
      attempts: [
        {
          seq: 1,
          providerId: "openai-compatible",
          connectionId: "conn-1",
          upstreamModel: "gpt-4o",
          status: 200,
          durationMs: 15,
          error: null,
        },
      ],
      usage: { inputTokens: 9, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 },
      error: null,
      ttfbMs: 4,
      requestBody: { model: "demo", messages: [{ role: "user", content: "hi" }] },
      responseBody: { id: "chatcmpl-1" },
      payloadTruncated: false,
    });
    await recorder.idle();

    const listed = store.listRequestLogs({ model: "demo" });
    assert.equal(listed[0]?.id, "req-jsonl-1");
    assert.equal(listed[0]?.inputTokens, 9);
    assert.equal(listed[0]?.cacheReadTokens, 2);
    assert.equal(listed[0]?.usageSource, "parser");
    assert.ok(listed[0]?.payloadPath);

    const payload = await readRequestPayload(dataDir, listed[0]?.payloadPath ?? null, listed[0]?.payloadOffset ?? null);
    assert.deepEqual(payload?.request, { model: "demo", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(payload?.response, { status: 200, body: { id: "chatcmpl-1" } });

    const file = await readFile(join(dataDir, listed[0]!.payloadPath!), "utf8");
    assert.match(file, /"id":"req-jsonl-1"/);
    assert.equal(file.trim().split("\n").length, 1);

    const stats = recorder.liveStats();
    assert.equal(stats.requests, 1);
    assert.equal(stats.inputTokens, 9);
    assert.equal(stats.outputTokens, 3);
  });

  it("re-enqueues events and avoids crashing when store insertion fails", async () => {
    const failingEvent = {
      id: "req-fail-1",
      startedAt: Date.now() - 10,
      endedAt: Date.now(),
      endpoint: "chat.completions" as const,
      stream: false,
      status: 500,
      outcome: "upstream_error" as const,
      requestModel: "fail-model",
      upstreamModel: "fail-model",
      providerId: "openai-compatible",
      connectionId: "conn-1",
      apiKeyId: null,
      apiKeyPrefix: null,
      attempts: [],
      usage: null,
      error: "simulated failure",
      ttfbMs: null,
      requestBody: null,
      responseBody: null,
      payloadTruncated: false,
    };

    // Temporarily sabotage insertRequestLog
    const originalInsert = store.insertRequestLog.bind(store);
    let failedOnce = false;
    store.insertRequestLog = (record, attempts) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("disk simulated full");
      }
      return originalInsert(record, attempts);
    };

    try {
      // record should not throw or trigger unhandled rejection
      recorder.record(failingEvent);
      // idle catches flush failure safely
      await recorder.idle();
    } finally {
      // Restore insertRequestLog
      store.insertRequestLog = originalInsert;
    }

    // Subsequent flush should successfully flush the re-enqueued event
    await recorder.idle();
    const listed = store.listRequestLogs({ model: "fail-model" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "req-fail-1");
  });
});

describe("request log privacy", () => {
  it("keeps gateway messages and hides plugin failures", () => {
    assert.equal(clientErrorMessage("model is required"), "model is required");
    assert.equal(clientErrorMessage("unknown model: demo"), "unknown model: demo");
    assert.equal(
      clientErrorMessage("no healthy connection served the model: connect ECONNREFUSED"),
      "no healthy connection served the model",
    );
    assert.equal(clientErrorMessage("provider exploded at https://upstream.internal"), "upstream request failed");
  });

  it("strips addresses, secrets, and mailbox text from logged errors", () => {
    const redacted = redactLogError(
      "provider exploded at https://user:pw@upstream.internal/v1 bearer sk-supersecretvalue ops@example.com 10.1.2.3",
    );
    assert.match(redacted ?? "", /provider exploded/);
    assert.equal(redacted?.includes("upstream.internal"), false);
    assert.equal(redacted?.includes("sk-supersecretvalue"), false);
    assert.equal(redacted?.includes("ops@example.com"), false);
    assert.equal(redacted?.includes("10.1.2.3"), false);
    assert.equal(redacted?.includes("user:pw"), false);
  });

  it("does not write a payload file unless asked", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-recorder-quiet-"));
    const store = await AdminStore.open(dataDir);
    const recorder = new RequestLogRecorder(store);
    try {
      recorder.record({
        id: "req-quiet",
        startedAt: Date.now() - 5,
        endedAt: Date.now(),
        endpoint: "chat.completions",
        stream: false,
        status: 200,
        outcome: "success",
        requestModel: "quiet",
        upstreamModel: "quiet",
        providerId: null,
        connectionId: null,
        apiKeyId: null,
        apiKeyPrefix: null,
        attempts: [],
        usage: null,
        error: null,
        ttfbMs: null,
        requestBody: { messages: [{ role: "user", content: "secret prompt" }] },
        responseBody: { text: "secret answer" },
        payloadTruncated: false,
      });
      await recorder.idle();
      const listed = store.listRequestLogs({ model: "quiet" });
      assert.equal(listed[0]?.payloadPath, null);
      assert.equal(listed[0]?.id, "req-quiet");
    } finally {
      await recorder.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
