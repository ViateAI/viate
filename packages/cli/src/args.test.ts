import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("parses plugin add with --data-dir", () => {
    assert.deepEqual(parseArgs(["--data-dir", "/tmp/viate", "plugin", "add", "./pkg.tgz"]), {
      dataDir: "/tmp/viate",
      command: { kind: "add", source: "./pkg.tgz" },
    });
  });

  it("parses plugin list", () => {
    assert.deepEqual(parseArgs(["plugin", "list"]), {
      dataDir: undefined,
      command: { kind: "list" },
    });
  });

  it("rejects leading-dash plugin sources and names", () => {
    assert.throws(() => parseArgs(["plugin", "add", "--reporter=json"]), /must not start with "-"/);
    assert.throws(() => parseArgs(["plugin", "remove", "-rf"]), /must not start with "-"/);
    assert.throws(() => parseArgs(["plugin", "update", "--config.ignore-scripts=false"]), /must not start with "-"/);
  });

  it("rejects unknown commands", () => {
    assert.throws(() => parseArgs(["plugin", "search"]), /usage:/);
  });
});
