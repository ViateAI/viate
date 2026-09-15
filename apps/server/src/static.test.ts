import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp, type App } from "./app.js";

describe("GET /admin", () => {
  let dir = "";
  let app: App;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "viate-ui-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>Viate Admin</title><div id=\"root\"></div>\n");
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "app.js"), "console.log('ok');\n");
    app = await buildApp({ logger: false, adminUiDist: dir });
  });

  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the admin shell and hashed assets", async () => {
    const page = await app.inject({ method: "GET", url: "/admin" });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(page.body, /Viate Admin/);

    const asset = await app.inject({ method: "GET", url: "/admin/assets/app.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.body, /console\.log/);
  });
});
