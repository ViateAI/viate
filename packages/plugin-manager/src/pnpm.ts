import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs.js";
import { runPnpm } from "./spawn.js";

const IGNORE_SCRIPTS = ["--config.ignore-scripts=true"] as const;

export async function initPluginWorkspace(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const packageJsonPath = join(dir, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(
        {
          name: "viate-plugins",
          private: true,
          type: "module",
          dependencies: {},
        },
        null,
        2,
      )}\n`,
    );
  }
  await writeFile(
    join(dir, ".npmrc"),
    ["ignore-scripts=true", "link-workspace-packages=false"].join("\n") + "\n",
  );
  if (!(await pathExists(join(dir, "pnpm-workspace.yaml")))) {
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - \".\"\n");
  }
}

export async function addPackage(dir: string, source: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await runPnpm(["add", "--workspace-root", ...IGNORE_SCRIPTS, "--", source], dir, env);
}

export async function updatePackage(
  dir: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await runPnpm(["update", "--workspace-root", ...IGNORE_SCRIPTS, "--", name], dir, env);
}

export async function removePackage(
  dir: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await runPnpm(["remove", "--workspace-root", ...IGNORE_SCRIPTS, "--", name], dir, env);
}
