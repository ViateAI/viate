import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildApp, createApp, type App } from "./app.js";
import { AdminStore } from "./store.js";

describe("client address behind a proxy", () => {
  it("trusts one forwarded hop only when asked", async () => {
    const trusted = createApp({ logger: false, trustProxy: "loopback,uniquelocal" });
    trusted.get("/who", (request) => ({ ip: request.ip }));
    const forwarded = await trusted.inject({
      method: "GET",
      url: "/who",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    assert.equal(forwarded.json().ip, "203.0.113.9");
    const publicPeer = await trusted.inject({
      method: "GET",
      url: "/who",
      remoteAddress: "203.0.113.50",
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    assert.equal(publicPeer.json().ip, "203.0.113.50");
    await trusted.close();

    const direct = createApp({ logger: false });
    direct.get("/who", (request) => ({ ip: request.ip }));
    const ignored = await direct.inject({
      method: "GET",
      url: "/who",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    assert.equal(ignored.json().ip, "10.0.0.8");
    await direct.close();
  });

  it("limits portal login per forwarded address and email", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-login-rate-"));
    const store = await AdminStore.open(dataDir);
    const app = await buildApp({ logger: false, store, trustProxy: "loopback,uniquelocal" });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await login(app, "a@example.com", "203.0.113.9");
        assert.equal(response.statusCode, 401);
      }
      const blocked = await login(app, "A@Example.com", "203.0.113.9");
      assert.equal(blocked.statusCode, 429);
      const otherEmail = await login(app, "b@example.com", "203.0.113.9");
      assert.equal(otherEmail.statusCode, 401);
      const otherAddress = await login(app, "a@example.com", "203.0.113.10");
      assert.equal(otherAddress.statusCode, 401);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

function login(app: App, email: string, forwardedFor: string) {
  return app.inject({
    method: "POST",
    url: "/api/portal/login",
    remoteAddress: "10.0.0.8",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "x-forwarded-for": forwardedFor,
    },
    payload: { email, password: "wrong-password" },
  });
}
