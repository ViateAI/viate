import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("reads server and admin settings", () => {
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "4321",
      VIATE_DATA_DIR: "/tmp/viate-data",
      VIATE_ADMIN_PASSWORD: "admin-secret",
    });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 4321);
    assert.equal(config.dataDir, "/tmp/viate-data");
    assert.equal(config.adminEnabled, true);
    assert.equal(config.adminPassword, "admin-secret");
  });

  it("disables admin when no password is provided", () => {
    const config = loadConfig({ VIATE_DATA_DIR: "/tmp/viate-data" });
    assert.equal(config.adminPassword, null);
    assert.equal(config.adminEnabled, false);
  });
});
