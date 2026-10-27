import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HttpExchange, ProviderHandler } from "@viateai/sdk";
import { deriveMessageHash, dispatchRouted, orderPool } from "./routing.js";
import type { AdminStore, PublishedMember } from "./store.js";

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

  it("hashes an image prompt when there is no chat turn", () => {
    assert.equal(deriveMessageHash({ prompt: "a lighthouse" })?.length, 16);
    assert.equal(deriveMessageHash({ prompt: "a lighthouse" }), deriveMessageHash({ prompt: "a lighthouse" }));
    assert.notEqual(deriveMessageHash({ prompt: "a lighthouse" }), deriveMessageHash({ prompt: "a harbor" }));
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

describe("dispatchRouted", () => {
  it("records the model id the plugin actually sent upstream", async () => {
    const exchange: HttpExchange = {
      status: 200,
      headers: {},
      body: null,
      upstreamModel: "gpt-5.4-mini-medium",
    };
    const providers = new Map<string, ProviderHandler>([[
      "cursor-oauth",
      {
        id: "cursor-oauth",
        async responses() {
          return exchange;
        },
      },
    ]]);
    const catalog = member("cursor-1", "cursor-oauth");
    catalog.modelId = "gpt-5.4-mini";
    const store = {
      listPublishedMembers: () => [catalog],
      orderMembers: (items: PublishedMember[]) => items,
      getLkgp: () => null,
      setLkgp: () => undefined,
    } as unknown as AdminStore;
    const routed = await dispatchRouted(
      store,
      providers,
      "responses",
      { body: { model: "gpt-5.4-mini" }, headers: {}, signal: AbortSignal.timeout(1000) },
      AbortSignal.timeout(1000),
    );
    assert.equal(routed.requestModel, "gpt-5.4-mini");
    assert.equal(routed.upstreamModel, "gpt-5.4-mini-medium");
    assert.equal(routed.attempts[0]?.upstreamModel, "gpt-5.4-mini-medium");
  });
});
