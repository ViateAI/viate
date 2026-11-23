import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateInputTokens, estimateOutputHoldTokens, estimateOutputTokens } from "./usage-estimate.js";

describe("estimateInputTokens", () => {
  it("counts message text and ignores role names", () => {
    assert.equal(estimateInputTokens({ messages: [{ role: "user", content: "hi" }] }), 1);
    assert.equal(
      estimateInputTokens({
        messages: [
          { role: "system", content: "" },
          { role: "user", content: "hi" },
        ],
      }),
      1,
    );
    assert.equal(
      estimateInputTokens({
        messages: [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
        ],
      }),
      1,
    );
    assert.equal(estimateInputTokens({ messages: [{ role: "user", content: "你好" }] }), 2);
  });

  it("returns 0 when the body has no extractable text", () => {
    assert.equal(estimateInputTokens(undefined), 0);
    assert.equal(estimateInputTokens({}), 0);
    assert.equal(estimateInputTokens({ messages: [] }), 0);
    assert.equal(estimateInputTokens({ messages: [{ role: "user", content: "" }] }), 0);
  });
});

describe("estimateOutputHoldTokens", () => {
  it("caps the first positive max and defaults to 256", () => {
    assert.equal(estimateOutputHoldTokens({ max_completion_tokens: 10, max_tokens: 5000 }), 10);
    assert.equal(estimateOutputHoldTokens({ max_tokens: 5000 }), 4096);
    assert.equal(estimateOutputHoldTokens({ max_tokens: 4096 }), 4096);
    assert.equal(estimateOutputHoldTokens({ max_output_tokens: 100 }), 100);
    assert.equal(estimateOutputHoldTokens({ max_tokens: 0, max_output_tokens: 3 }), 3);
    assert.equal(estimateOutputHoldTokens({ max_tokens: 1.5 }), 256);
    assert.equal(estimateOutputHoldTokens({}), 256);
    assert.equal(estimateOutputHoldTokens(null), 256);
  });
});

describe("estimateOutputTokens", () => {
  it("counts SSE delta content and not the framing", () => {
    const sse = ['data: {"choices":[{"delta":{"content":"abcd"}}]}', "", "data: [DONE]", ""].join("\n");
    assert.equal(estimateOutputTokens(sse, "text/event-stream"), 1);
    assert.equal(
      estimateOutputTokens('data: {"choices":[{"delta":{}}]}\n\n', "text/event-stream"),
      0,
    );
  });

  it("counts JSON message text and returns 0 for an empty body", () => {
    assert.equal(
      estimateOutputTokens(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        "application/json",
      ),
      1,
    );
    assert.equal(estimateOutputTokens("", "application/json"), 0);
    assert.equal(estimateOutputTokens("{}", "application/json"), 0);
  });
});
