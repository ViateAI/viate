import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type PluginPackageJson = {
  name: string;
  version: string;
  viate?: {
    id?: string;
    entry?: string;
  };
};

export type LoadedManifest = {
  name: string;
  version: string;
  id: string | null;
  entry: string | null;
  packageDir: string;
  packageJsonPath: string;
};

export async function readPackageJson(packageDir: string): Promise<PluginPackageJson> {
  const packageJsonPath = join(packageDir, "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid package.json: ${packageJsonPath}`);
  }
  if (!("name" in parsed) || typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error(`package.json missing name: ${packageJsonPath}`);
  }
  const version =
    "version" in parsed && typeof parsed.version === "string" ? parsed.version : "0.0.0";
  const viate =
    "viate" in parsed && parsed.viate && typeof parsed.viate === "object"
      ? parsed.viate
      : undefined;
  const id =
    viate && "id" in viate && typeof viate.id === "string" && viate.id.trim().length > 0
      ? viate.id.trim()
      : null;
  const entry =
    viate && "entry" in viate && typeof viate.entry === "string" && viate.entry.trim().length > 0
      ? viate.entry.trim()
      : null;
  return {
    name: parsed.name,
    version,
    viate: id || entry ? { id: id ?? undefined, entry: entry ?? undefined } : undefined,
  };
}

export async function loadManifest(packageDir: string): Promise<LoadedManifest> {
  const pkg = await readPackageJson(packageDir);
  return {
    name: pkg.name,
    version: pkg.version,
    id: pkg.viate?.id ?? null,
    entry: pkg.viate?.entry ?? null,
    packageDir,
    packageJsonPath: join(packageDir, "package.json"),
  };
}

export function resolveEntryUrl(packageDir: string, entry: string): string {
  return pathToFileURL(join(packageDir, entry)).href;
}
