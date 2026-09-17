import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { pluginLoggerFromFastify } from "./plugin-log.js";

describe("pluginLoggerFromFastify", () => {
  it("adapts SDK logger writes onto Fastify without plugins importing Fastify", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: "debug",
        stream: new Writable({
          write(chunk, _encoding, callback) {
            lines.push(String(chunk));
            callback();
          },
        }),
      },
    });
    try {
      pluginLoggerFromFastify(app.log)
        .child({ plugin: "grok" })
        .warn({ connectionId: "c1", status: 400 }, "token refresh failed");
      const entry = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.msg === "token refresh failed");
      assert.equal(entry?.plugin, "grok");
      assert.equal(entry?.connectionId, "c1");
      assert.equal(entry?.status, 400);
    } finally {
      await app.close();
    }
  });
});
