import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function copyDir(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await mkdir(join(to, ".."), { recursive: true });
  // verbatimSymlinks keeps pnpm's relative node_modules links relative. The
  // default converts them to absolute paths at the source; a later rename of
  // the tree then leaves dangling targets.
  await cp(from, to, { recursive: true, force: true, verbatimSymlinks: true });
}

export async function replaceDir(from: string, to: string, backup: string): Promise<void> {
  await rm(backup, { recursive: true, force: true });
  if (await pathExists(to)) {
    await rename(to, backup);
  }
  try {
    await mkdir(join(to, ".."), { recursive: true });
    await rename(from, to);
  } catch (error) {
    if (await pathExists(backup)) {
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      await rename(backup, to);
    }
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

export async function listInstalledPackages(workspaceDir: string): Promise<string[]> {
  const nodeModules = join(workspaceDir, "node_modules");
  let entries;
  try {
    entries = await readdir(nodeModules, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.name === ".pnpm" || entry.name === ".bin") {
      continue;
    }
    if (entry.name.startsWith("@")) {
      const scoped = await readdir(join(nodeModules, entry.name), { withFileTypes: true });
      for (const child of scoped) {
        if (child.isDirectory() || child.isSymbolicLink()) {
          names.push(`${entry.name}/${child.name}`);
        }
      }
      continue;
    }
    names.push(entry.name);
  }
  return names.sort();
}

export async function writeReadyMarker(path: string): Promise<void> {
  await writeFile(path, `${new Date().toISOString()}\n`, "utf8");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
