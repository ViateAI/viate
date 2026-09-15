import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { definePlugin, pickAllowedHeaders } from "./index.js";

describe("definePlugin", () => {
  it("returns the plugin when id and register are present", () => {
    const plugin = definePlugin({
      id: "example",
      register() {},
    });
    assert.equal(plugin.id, "example");
  });

  it("rejects a missing id", () => {
    assert.throws(
      () =>
        definePlugin({
          id: "  ",
          register() {},
        }),
      /plugin id is required/,
    );
  });
});

describe("pickAllowedHeaders", () => {
  it("copies allowlisted protocol headers and drops auth cookies", () => {
    const picked = pickAllowedHeaders({
      Authorization: "Bearer client-secret",
      Cookie: "viate_admin=abc",
      "Anthropic-Beta": "tools-2024",
      "openai-beta": "assistants=v2",
      "x-api-key": "nope",
    });
    assert.deepEqual(picked, {
      "anthropic-beta": "tools-2024",
      "openai-beta": "assistants=v2",
    });
  });
});
