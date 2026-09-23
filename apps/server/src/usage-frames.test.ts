import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAnthropicUsage, parseOpenAIChatUsage, parseOpenAIResponsesUsage } from "@viateai/sdk";
import { frameJson, frameSse, tapExchange } from "./usage-frames.js";

describe("frameJson", () => {
  it("wraps a parsed JSON object as a single frame", () => {
    assert.deepEqual(frameJson(`{"usage":{"prompt_tokens":3}}`), [{ usage: { prompt_tokens: 3 } }]);
  });

  it("returns no frames for invalid JSON", () => {
    assert.deepEqual(frameJson("{"), []);
  });
});

describe("frameSse", () => {
  it("parses data frames and skips [DONE]", () => {
    const text = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}",
      "",
      "data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1}}",
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const frames = frameSse(text);
    assert.equal(frames.length, 2);
    assert.deepEqual(parseOpenAIChatUsage(frames), {
      inputTokens: 9,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("preserves usage frames even when stream exceeds SSE frame cap", () => {
    const lines: string[] = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}',
      "",
    ];
    for (let i = 0; i < 100; i += 1) {
      lines.push(`data: {"type":"content_block_delta","delta":{"text":"token_${i}"}}`, "");
    }
    lines.push('data: {"type":"message_delta","usage":{"output_tokens":25}}', "", "data: [DONE]", "");
    const frames = frameSse(lines.join("\n"));
    const anthropicUsage = parseAnthropicUsage(frames);
    assert.deepEqual(anthropicUsage, {
      inputTokens: 65,
      outputTokens: 25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });
  it("preserves nested Responses usage after the SSE frame cap", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      lines.push(`data: {"type":"response.output_text.delta","delta":"token_${i}"}`, "");
    }
    lines.push(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":40,"output_tokens":12,"input_tokens_details":{"cached_tokens":15}}}}',
      "",
    );
    for (let i = 0; i < 100; i += 1) {
      lines.push(`data: {"type":"response.output_text.delta","delta":"after_${i}"}`, "");
    }
    lines.push("data: [DONE]", "");
    const frames = frameSse(lines.join("\n"));
    assert.deepEqual(parseOpenAIResponsesUsage(frames), {
      inputTokens: 40,
      outputTokens: 12,
      cacheReadTokens: 15,
      cacheWriteTokens: 0,
    });
  });
});

describe("tapExchange", () => {
  it("tees the body so the client copy matches the tap copy", async () => {
    const text = JSON.stringify({
      usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
    });
    const { exchange, tap } = tapExchange({
      status: 200,
      headers: { "content-type": "application/json" },
      body: streamOf(text),
      parseUsage: parseOpenAIChatUsage,
    });
    assert.ok(exchange.body);
    const [client, result] = await Promise.all([new Response(exchange.body).text(), tap]);
    assert.equal(client, text);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.usage, {
      inputTokens: 4,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(result.responseBody, JSON.parse(text));
  });

  it("keeps SSE bytes intact while framing usage from data lines", async () => {
    const text = "data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
    const { exchange, tap } = tapExchange({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: streamOf(text),
      parseUsage: parseOpenAIChatUsage,
    });
    const [client, result] = await Promise.all([new Response(exchange.body).text(), tap]);
    assert.equal(client, text);
    assert.deepEqual(result.usage, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(result.responseBody, text);
  });

  it("returns missing usage when parseUsage is omitted", async () => {
    const { exchange, tap } = tapExchange({
      status: 200,
      headers: { "content-type": "application/json" },
      body: streamOf(`{"ok":true}`),
    });
    await new Response(exchange.body).text();
    const result = await tap;
    assert.equal(result.usage, null);
  });
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
