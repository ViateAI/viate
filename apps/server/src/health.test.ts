import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildApp, type App } from "./app.js";

describe("GET /health", () => {
  let app!: App;

  before(async () => {
    app = await buildApp({ logger: false });
  });

  after(async () => {
    await app.close();
  });

  it("returns 200 and { status: \"ok\" }", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /^application\/json\b/);
    assert.deepEqual(response.json(), { status: "ok" });
  });
});
