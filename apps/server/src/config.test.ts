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
    assert.equal(config.trustProxy, "loopback,uniquelocal");
    assert.equal(config.userMaxInflight, 8);
    assert.equal(config.logPayloads, false);
    assert.equal(config.requestLogRetentionMs, 7 * 24 * 60 * 60 * 1000);
  });

  it("disables admin when no password is provided", () => {
    const config = loadConfig({ VIATE_DATA_DIR: "/tmp/viate-data" });
    assert.equal(config.adminPassword, null);
    assert.equal(config.adminEnabled, false);
  });

  it("reads proxy, in-flight, payload, and retention overrides", () => {
    const config = loadConfig({
      VIATE_DATA_DIR: "/tmp/viate-data",
      VIATE_TRUST_PROXY: "false",
      VIATE_USER_MAX_INFLIGHT: "3",
      VIATE_LOG_PAYLOADS: "true",
      VIATE_REQUEST_LOG_RETENTION_DAYS: "2",
    });
    assert.equal(config.trustProxy, false);
    assert.equal(config.userMaxInflight, 3);
    assert.equal(config.logPayloads, true);
    assert.equal(config.requestLogRetentionMs, 2 * 24 * 60 * 60 * 1000);
    assert.throws(() => loadConfig({ VIATE_USER_MAX_INFLIGHT: "0" }), /VIATE_USER_MAX_INFLIGHT/);
    assert.equal(loadConfig({ VIATE_TRUST_PROXY: "127.0.0.1,::1" }).trustProxy, "127.0.0.1,::1");
    assert.throws(() => loadConfig({ VIATE_TRUST_PROXY: "1" }), /VIATE_TRUST_PROXY/);
    assert.throws(() => loadConfig({ VIATE_TRUST_PROXY: "beside" }), /VIATE_TRUST_PROXY/);
    assert.throws(() => loadConfig({ VIATE_LOG_PAYLOADS: "sometimes" }), /VIATE_LOG_PAYLOADS/);
  });
});
