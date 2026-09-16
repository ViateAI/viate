import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveMessageHash, orderPool } from "./routing.js";
import type { PublishedMember } from "./store.js";

function member(connectionId: string, providerId = "openai-compatible"): PublishedMember {
  return {
    connectionId,
    providerId,
    modelId: "gpt-4o",
    name: "gpt-4o",
    contextLength: null,
    displayLabel: connectionId,
    keepaliveStatus: "ok",
    createdAt: "2026-01-01T00:00:00.000Z",
    credentials: {},
  };
}

describe("deriveMessageHash", () => {
  it("hashes the first user turn from chat messages", () => {
    assert.equal(
      deriveMessageHash({ messages: [{ role: "user", content: "hello world" }] })?.length,
      16,
    );
    assert.equal(
      deriveMessageHash({ messages: [{ role: "user", content: "hello world" }] }),
      deriveMessageHash({ input: "hello world" }),
    );
  });

  it("returns null when no user text exists", () => {
    assert.equal(deriveMessageHash({ messages: [{ role: "assistant", content: "hi" }] }), null);
    assert.equal(deriveMessageHash({}), null);
  });
});

describe("orderPool", () => {
  it("promotes sticky after LKGP", () => {
    const ordered = orderPool([member("a"), member("b"), member("c")], {
      lkgpConnectionId: "b",
      stickyConnectionId: "c",
    });
    assert.deepEqual(ordered.map((item) => item.connectionId), ["c", "b", "a"]);
  });
});
