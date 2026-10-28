import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { ProviderHandler } from "@viateai/sdk";
import { buildApp, type App } from "./app.js";
import { resetRoutingStateForTests } from "./routing.js";
import { AdminStore } from "./store.js";

const HOST = "localhost:80";
const ORIGIN = "http://localhost:80";

describe("per-user model visibility", () => {
  it("follows every published model when the user has no saved rows", async () => {
    const fixture = await openFixture(1);
    try {
      const session = await loginPortal(fixture.app, fixture.email, fixture.password);
      const choice = await portal(fixture.app, session, { method: "GET", url: "/api/portal/models" });
      assert.equal(choice.statusCode, 200);
      assert.equal(choice.json().mode, "all");
      assert.deepEqual(choice.json().modelIds, []);
      assert.deepEqual(
        choice.json().published,
        [
          { id: "demo", name: "Demo" },
          { id: "other", name: "Other" },
        ],
      );

      const models = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.equal(models.statusCode, 200);
      assert.deepEqual(models.json(), fixture.store.listPublicCatalog());

      const unbound = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${fixture.unbound}` },
      });
      assert.deepEqual(unbound.json(), models.json());

      const chat = await chatCompletion(fixture.app, fixture.secret, "demo");
      assert.equal(chat.statusCode, 200);
      assert.deepEqual(fixture.calls, ["demo"]);
    } finally {
      await fixture.close();
    }
  });

  it("filters the catalog and rejects another published model before admission", async () => {
    const fixture = await openFixture(0);
    try {
      const session = await loginPortal(fixture.app, fixture.email, fixture.password);
      const saved = await portal(fixture.app, session, {
        method: "PUT",
        url: "/api/portal/models",
        payload: { modelIds: ["demo", "demo", " demo "] },
      });
      assert.equal(saved.statusCode, 200);
      assert.equal(saved.json().mode, "only");
      assert.deepEqual(saved.json().modelIds, ["demo"]);
      assert.deepEqual(fixture.store.userModelChoice(fixture.userId), { mode: "only", modelIds: ["demo"] });

      const models = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.equal(models.statusCode, 200);
      assert.deepEqual(models.json(), {
        object: "list",
        data: fixture.store.listPublicCatalog().data.filter((model) => model.id === "demo"),
      });

      const unbound = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${fixture.unbound}` },
      });
      assert.deepEqual(catalogIds(unbound.json()), ["demo", "other"]);

      const denied = await chatCompletion(fixture.app, fixture.secret, "other");
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.message, "model not available");
      assert.deepEqual(fixture.calls, []);
      assert.equal(readInflight(fixture.dataDir, fixture.userId), 0);

      const missingVoice = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: "other", input: "hello" },
      });
      assert.equal(missingVoice.statusCode, 400);
      assert.equal(missingVoice.json().error.message, "voice is required");

      const deniedSpeech = await fixture.app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        headers: { authorization: `Bearer ${fixture.secret}` },
        payload: { model: "other", input: "hello", voice: "alloy" },
      });
      assert.equal(deniedSpeech.statusCode, 403);
      assert.equal(deniedSpeech.json().error.message, "model not available");

      fixture.store.grantUsd(fixture.userId, "1");
      const blank = await chatCompletion(fixture.app, fixture.secret, "  ");
      assert.equal(blank.statusCode, 400);
      assert.equal(blank.json().error.message, "model is required");
      assert.deepEqual(fixture.calls, []);
      assert.equal(readInflight(fixture.dataDir, fixture.userId), 0);

      const allowed = await chatCompletion(fixture.app, fixture.secret, "demo");
      assert.equal(allowed.statusCode, 200);
      assert.deepEqual(fixture.calls, ["demo"]);
    } finally {
      await fixture.close();
    }
  });

  it("restores follow-all when the portal sends null", async () => {
    const fixture = await openFixture(1);
    try {
      const session = await loginPortal(fixture.app, fixture.email, fixture.password);
      const saved = await portal(fixture.app, session, {
        method: "PUT",
        url: "/api/portal/models",
        payload: { modelIds: ["demo"] },
      });
      assert.equal(saved.statusCode, 200);

      fixture.store.replaceConnectionModels(fixture.connectionId, [
        { id: "demo", name: "Demo" },
        { id: "other", name: "Other" },
        { id: "fresh", name: "Fresh" },
      ]);
      const narrowed = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.deepEqual(catalogIds(narrowed.json()), ["demo"]);

      const restored = await portal(fixture.app, session, {
        method: "PUT",
        url: "/api/portal/models",
        payload: { modelIds: null },
      });
      assert.equal(restored.statusCode, 200);
      assert.equal(restored.json().mode, "all");
      assert.deepEqual(restored.json().modelIds, []);
      assert.deepEqual(fixture.store.userModelChoice(fixture.userId), { mode: "all" });

      const models = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.deepEqual(catalogIds(models.json()), ["demo", "fresh", "other"]);
      const chat = await chatCompletion(fixture.app, fixture.secret, "fresh");
      assert.equal(chat.statusCode, 200);
      assert.deepEqual(fixture.calls, ["fresh"]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects an unpublished model id without replacing the saved set", async () => {
    const fixture = await openFixture(1);
    try {
      const session = await loginPortal(fixture.app, fixture.email, fixture.password);
      const saved = await portal(fixture.app, session, {
        method: "PUT",
        url: "/api/portal/models",
        payload: { modelIds: ["other"] },
      });
      assert.equal(saved.statusCode, 200);

      const rejected = await portal(fixture.app, session, {
        method: "PUT",
        url: "/api/portal/models",
        payload: { modelIds: ["not-published"] },
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.json().error.message, "unknown model");
      assert.deepEqual(fixture.store.userModelChoice(fixture.userId), { mode: "only", modelIds: ["other"] });

      const models = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.deepEqual(catalogIds(models.json()), ["other"]);
    } finally {
      await fixture.close();
    }
  });

  it("hides every model when the saved set is empty", async () => {
    const fixture = await openFixture(0);
    try {
      const session = await loginPortal(fixture.app, fixture.email, fixture.password);
      const saved = await portal(fixture.app, session, {
        method: "PUT",
        url: "/api/portal/models",
        payload: { modelIds: [] },
      });
      assert.equal(saved.statusCode, 200);
      assert.equal(saved.json().mode, "only");
      assert.deepEqual(saved.json().modelIds, []);
      assert.deepEqual(fixture.store.userModelChoice(fixture.userId), { mode: "only", modelIds: [] });

      const models = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${fixture.secret}` },
      });
      assert.equal(models.statusCode, 200);
      assert.deepEqual(models.json(), { object: "list", data: [] });

      const denied = await chatCompletion(fixture.app, fixture.secret, "demo");
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.message, "model not available");
      assert.deepEqual(fixture.calls, []);
      assert.equal(readInflight(fixture.dataDir, fixture.userId), 0);
    } finally {
      await fixture.close();
    }
  });
});

type Fixture = {
  dataDir: string;
  store: AdminStore;
  app: App;
  calls: string[];
  secret: string;
  unbound: string;
  userId: string;
  email: string;
  password: string;
  connectionId: string;
  close: () => Promise<void>;
};

async function openFixture(balance: number): Promise<Fixture> {
  resetRoutingStateForTests();
  const dataDir = await mkdtemp(join(tmpdir(), "viate-user-models-"));
  const store = await AdminStore.open(dataDir);
  const calls: string[] = [];
  const connection = store.createConnection("openai-compatible");
  store.putCredentials(connection.id, { token: "k" }, "primary");
  store.setActive(connection.id, true);
  store.replaceConnectionModels(connection.id, [
    { id: "demo", name: "Demo" },
    { id: "other", name: "Other" },
  ]);
  const email = `user-${randomUUID()}@example.com`;
  const password = "password1";
  const user = store.createUser({ email, name: "Member", password });
  if (balance !== 0) {
    store.grantUsd(user.id, String(balance));
  }
  const secret = store.createApiKey("member", user.id).secret;
  const unbound = store.createApiKey("legacy").secret;
  const provider: ProviderHandler = {
    id: "openai-compatible",
    async chatCompletions(request) {
      calls.push(modelOf(request.body));
      return { status: 200, headers: { "content-type": "application/json" }, body: jsonBody() };
    },
    async audioSpeech(request) {
      calls.push(`audio:${modelOf(request.body)}`);
      return { status: 200, headers: { "content-type": "audio/mpeg" }, body: jsonBody() };
    },
  };
  const app = await buildApp({
    logger: false,
    store,
    providers: [provider],
    modelPrices: {
      ready: true,
      lookup() {
        return { inputNanoPerMillion: 1_000_000_000, outputNanoPerMillion: 1_000_000_000 };
      },
    },
    adminPassword: "correct-horse",
    adminEnabled: true,
  });
  return {
    dataDir,
    store,
    app,
    calls,
    secret,
    unbound,
    userId: user.id,
    email,
    password,
    connectionId: connection.id,
    async close() {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function modelOf(body: unknown): string {
  if (!body || typeof body !== "object" || !("model" in body) || typeof body.model !== "string") {
    return "";
  }
  return body.model;
}

function catalogIds(payload: unknown): string[] {
  assert.ok(payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data));
  return payload.data.map((model) => {
    assert.ok(model && typeof model === "object" && "id" in model && typeof model.id === "string");
    return model.id;
  });
}

function jsonBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    },
  });
}

function readInflight(dataDir: string, userId: string): number {
  const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
  try {
    const row = db.prepare("SELECT inflight FROM users WHERE id = ?").get(userId) as { inflight: number | bigint };
    return Number(row.inflight);
  } finally {
    db.close();
  }
}

function chatCompletion(app: App, secret: string, model: unknown) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${secret}` },
    payload: { model, messages: [{ role: "user", content: "hi" }] },
  });
}

type Session = { cookie: string; csrf: string };

async function loginPortal(app: App, email: string, password: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/portal/login",
    headers: { host: HOST, origin: ORIGIN },
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response.headers["set-cookie"]), csrf: response.json().csrf as string };
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.map((part) => String(part).split(";")[0]).join("; ");
}

async function portal(
  app: App,
  session: Session,
  options: { method: "GET" | "PUT"; url: string; payload?: Record<string, unknown> | { modelIds: null } },
) {
  return app.inject({
    method: options.method,
    url: options.url,
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: session.cookie,
      ...(options.method === "GET" ? {} : { "x-viate-csrf": session.csrf }),
    },
    payload: options.payload,
  });
}
