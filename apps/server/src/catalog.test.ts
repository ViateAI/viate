import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRequestModel } from "./catalog.js";

describe("parseRequestModel", () => {
  it("treats a loaded provider prefix as a pin", () => {
    assert.deepEqual(parseRequestModel("openai-compatible/gpt-4o", ["openai-compatible"]), {
      kind: "pin",
      providerId: "openai-compatible",
      modelId: "gpt-4o",
    });
  });

  it("keeps slashy upstream ids as aggregates when the prefix is not a loaded provider", () => {
    assert.deepEqual(parseRequestModel("org/gpt-4o", ["openai-compatible"]), {
      kind: "aggregate",
      modelId: "org/gpt-4o",
    });
  });
});
