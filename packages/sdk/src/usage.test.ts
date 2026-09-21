import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAnthropicUsage, parseOpenAIChatUsage, parseOpenAIResponsesUsage } from "./usage.js";

describe("parseOpenAIChatUsage", () => {
  it("reads prompt/completion tokens and cached prompt tokens from the last usage frame", () => {
    assert.deepEqual(
      parseOpenAIChatUsage([
        { choices: [{ delta: { content: "hi" } }] },
        {
          usage: {
            prompt_tokens: 20,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        },
      ]),
      {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 8,
        cacheWriteTokens: 0,
      },
    );
  });

  it("returns null when no usage object is present", () => {
    assert.equal(parseOpenAIChatUsage([{ choices: [] }]), null);
    assert.equal(parseOpenAIChatUsage([]), null);
  });
});

describe("parseOpenAIResponsesUsage", () => {
  it("reads input/output tokens and cached input tokens", () => {
    assert.deepEqual(
      parseOpenAIResponsesUsage([
        {
          usage: {
            input_tokens: 40,
            output_tokens: 12,
            input_tokens_details: { cached_tokens: 15 },
          },
        },
      ]),
      {
        inputTokens: 40,
        outputTokens: 12,
        cacheReadTokens: 15,
        cacheWriteTokens: 0,
      },
    );
  });
});

describe("parseAnthropicUsage", () => {
  it("sums billed input across message_start and message_delta frames", () => {
    assert.deepEqual(
      parseAnthropicUsage([
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 6,
              cache_creation_input_tokens: 2,
            },
          },
        },
        { type: "content_block_delta", delta: { text: "hi" } },
        { type: "message_delta", usage: { output_tokens: 4 } },
      ]),
      {
        inputTokens: 18,
        outputTokens: 4,
        cacheReadTokens: 6,
        cacheWriteTokens: 2,
      },
    );
  });

  it("returns null when Anthropic usage fields are absent", () => {
    assert.equal(parseAnthropicUsage([{ type: "ping" }]), null);
  });
});
