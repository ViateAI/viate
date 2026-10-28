import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProviderHandler } from "@viateai/sdk";
import { buildApp, type App } from "./app.js";
import { resetRoutingStateForTests } from "./routing.js";
import { AdminStore } from "./store.js";

describe("per-user provider visibility", () => {
  it("hides a private provider from a customer while an unbound key can still use it", async () => {
    const fixture = await openFixture();
    try {
      const openModels = await models(fixture.app, fixture.secret);
      assert.deepEqual(ids(openModels.json()), ["composer", "grok", "shared"]);

      fixture.store.setUserProviders(fixture.userId, ["xai"]);
      const limited = await models(fixture.app, fixture.secret);
      assert.equal(limited.statusCode, 200);
      assert.deepEqual(ids(limited.json()), ["grok", "shared"]);
      assert.equal(limited.json().data.find((model: { id: string }) => model.id === "shared").owned_by, "xai");

      const hidden = await chat(fixture.app, fixture.secret, "composer");
      assert.equal(hidden.statusCode, 403);
      assert.equal(hidden.json().error.message, "provider not available");
      assert.deepEqual(fixture.calls, []);

      const pinned = await chat(fixture.app, fixture.secret, "cursor/shared");
      assert.equal(pinned.statusCode, 403);
      assert.equal(pinned.json().error.message, "provider not available");

      const allowed = await chat(fixture.app, fixture.secret, "shared");
      assert.equal(allowed.statusCode, 200);
      assert.deepEqual(fixture.calls, ["xai:shared"]);

      const unboundModels = await models(fixture.app, fixture.unbound);
      assert.deepEqual(ids(unboundModels.json()), ["composer", "grok", "shared"]);
      const privateCall = await chat(fixture.app, fixture.unbound, "composer");
      assert.equal(privateCall.statusCode, 200);
      assert.deepEqual(fixture.calls.at(-1), "cursor:composer");
    } finally {
      await fixture.close();
    }
  });

  it("rejects an unknown provider and an empty selection hides every model", async () => {
    const fixture = await openFixture();
    try {
      assert.throws(
        () => fixture.store.setUserProviders(fixture.userId, ["missing"]),
        (error: unknown) => error instanceof Error && error.message === "unknown provider",
      );
      fixture.store.setUserProviders(fixture.userId, []);
      const listed = await models(fixture.app, fixture.secret);
      assert.deepEqual(listed.json().data, []);
      const denied = await chat(fixture.app, fixture.secret, "grok");
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.message, "provider not available");
      fixture.store.setUserProviders(fixture.userId, null);
      assert.equal(fixture.store.userProviderChoice(fixture.userId).mode, "all");
      assert.deepEqual(ids((await models(fixture.app, fixture.secret)).json()), ["composer", "grok", "shared"]);
    } finally {
      await fixture.close();
    }
  });
});

async function openFixture() {
  resetRoutingStateForTests();
  const dataDir = await mkdtemp(join(tmpdir(), "viate-user-providers-"));
  const store = await AdminStore.open(dataDir);
  const calls: string[] = [];
  const xai = store.createConnection("xai");
  const cursor = store.createConnection("cursor");
  store.putCredentials(xai.id, { token: "x" }, "xai");
  store.putCredentials(cursor.id, { token: "c" }, "cursor");
  store.setActive(xai.id, true);
  store.setActive(cursor.id, true);
  store.replaceConnectionModels(xai.id, [
    { id: "grok", name: "Grok" },
    { id: "shared", name: "Shared" },
  ]);
  store.replaceConnectionModels(cursor.id, [
    { id: "composer", name: "Composer" },
    { id: "shared", name: "Shared" },
  ]);
  const user = store.createUser({ email: "customer@example.com", name: "Customer", password: "password1" });
  store.grantUsd(user.id, "1");
  const secret = store.createApiKey("customer", user.id).secret;
  const unbound = store.createApiKey("self-test").secret;
  const provider = (id: string): ProviderHandler => ({
    id,
    async chatCompletions(request) {
      const model = request.body && typeof request.body === "object" && "model" in request.body ? String(request.body.model) : "";
      calls.push(`${id}:${model}`);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          },
        }),
      };
    },
  });
  const app = await buildApp({
    logger: false,
    store,
    providers: [provider("xai"), provider("cursor")],
    modelPrices: {
      ready: true,
      lookup() {
        return { inputNanoPerMillion: 1_000_000_000, outputNanoPerMillion: 1_000_000_000 };
      },
    },
  });
  return {
    app,
    store,
    calls,
    secret,
    unbound,
    userId: user.id,
    async close() {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function models(app: App, secret: string) {
  return app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${secret}` } });
}

function chat(app: App, secret: string, model: string) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${secret}` },
    payload: { model, messages: [{ role: "user", content: "hi" }] },
  });
}

function ids(payload: { data: Array<{ id: string }> }): string[] {
  return payload.data.map((model) => model.id);
}
