import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSafePackageArg, redactSource } from "./source.js";

describe("assertSafePackageArg", () => {
  it("rejects leading-dash sources and names", () => {
    assert.throws(() => assertSafePackageArg("-e", "source"), /must not start with "-"/);
    assert.throws(() => assertSafePackageArg("--reporter", "name"), /must not start with "-"/);
  });

  it("accepts tarball paths and scoped names", () => {
    assert.equal(assertSafePackageArg("./plugin.tgz", "source"), "./plugin.tgz");
    assert.equal(assertSafePackageArg("@viateai/plugin-openai-compatible", "name"), "@viateai/plugin-openai-compatible");
  });
});

describe("redactSource", () => {
  it("strips URL userinfo and query secrets", () => {
    assert.equal(
      redactSource("https://user:ghp_secret@github.com/org/repo.git?token=abc#frag"),
      "https://github.com/org/repo.git",
    );
    assert.equal(
      redactSource("git+https://token@github.com/org/repo.git"),
      "git+https://github.com/org/repo.git",
    );
  });

  it("leaves local paths unchanged", () => {
    assert.equal(redactSource("/tmp/plugin.tgz"), "/tmp/plugin.tgz");
  });
});
