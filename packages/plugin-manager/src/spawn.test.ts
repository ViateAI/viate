import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pluginSubprocessEnv } from "./spawn.js";

describe("pluginSubprocessEnv", () => {
  it("omits Viate credentials and other secret-looking variables", () => {
    const env = pluginSubprocessEnv({
      PATH: "/usr/bin",
      VIATE_PNPM: "pnpm",
      VIATE_DATA_DIR: "/data",
      VIATE_ADMIN_PASSWORD: "admin-secret",
      VIATE_UPSTREAM_API_KEY: "upstream-secret",
      NPM_TOKEN: "npm-secret",
      SAFE: "ok",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.VIATE_PNPM, "pnpm");
    assert.equal(env.VIATE_DATA_DIR, "/data");
    assert.equal(env.SAFE, "ok");
    assert.equal(env.npm_config_ignore_scripts, "true");
    assert.equal(env.VIATE_ADMIN_PASSWORD, undefined);
    assert.equal(env.VIATE_UPSTREAM_API_KEY, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
  });
});
