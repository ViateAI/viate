import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { copyDir, replaceDir } from "./fs.js";

describe("copyDir", () => {
  it("keeps relative symlinks valid after copy and rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "viate-copy-"));
    try {
      const from = join(root, "from");
      const store = join(from, ".store", "pkg");
      const linkDir = join(from, "node_modules");
      await mkdir(store, { recursive: true });
      await mkdir(linkDir, { recursive: true });
      await writeFile(join(store, "marker.txt"), "ok\n");
      await symlink("../.store/pkg", join(linkDir, "pkg"));

      const copied = join(root, "copied");
      await copyDir(from, copied);
      const dest = join(root, "dest");
      await replaceDir(copied, dest, join(root, "backup"));

      const linked = join(dest, "node_modules", "pkg", "marker.txt");
      assert.equal(await readFile(linked, "utf8"), "ok\n");
      const resolved = await realpath(join(dest, "node_modules", "pkg"));
      assert.equal(resolved, await realpath(join(dest, ".store", "pkg")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
