import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPluginLogger, definePlugin, pickAllowedHeaders, silentPluginLogger } from "./index.js";

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

  it("silentPluginLogger no-ops and returns itself from child", () => {
    const log = silentPluginLogger();
    log.debug("ignored");
    log.info({ token: "secret" }, "ignored");
    log.warn("ignored");
    log.error({ err: new Error("boom") }, "ignored");
    log.child({ plugin: "demo" }).warn("ignored");
  });
});

describe("createPluginLogger", () => {
  it("writes levels, merges child bindings, and keeps the host sink framework-agnostic", () => {
    const writes: Array<{
      level: string;
      fields: Record<string, unknown> | undefined;
      message: string;
    }> = [];
    const log = createPluginLogger((level, fields, message) => {
      writes.push({ level, fields, message });
    }).child({ plugin: "grok" });
    log.warn("plain");
    log.warn({ connectionId: "c1", status: 400 }, "token refresh failed");
    log.child({ connectionId: "c2" }).error({ err: "timeout" }, "keepalive failed");
    assert.deepEqual(writes, [
      { level: "warn", fields: { plugin: "grok" }, message: "plain" },
      {
        level: "warn",
        fields: { plugin: "grok", connectionId: "c1", status: 400 },
        message: "token refresh failed",
      },
      {
        level: "error",
        fields: { plugin: "grok", connectionId: "c2", err: "timeout" },
        message: "keepalive failed",
      },
    ]);
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
