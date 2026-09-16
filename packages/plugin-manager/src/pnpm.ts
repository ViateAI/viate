import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs.js";
import { runPnpm } from "./spawn.js";

const IGNORE_SCRIPTS = ["--config.ignore-scripts=true"] as const;
const HOST_SDK = "@viateai/sdk";

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
  await ensureHostSdkPeerRule(dir);
}

export async function ensureHostSdkPeerRule(dir: string): Promise<void> {
  await writeFile(
    join(dir, ".npmrc"),
    ["ignore-scripts=true", "link-workspace-packages=false"].join("\n") + "\n",
  );
  await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "."\n');
  await writeFile(join(dir, ".pnpmfile.cjs"), hostSdkPnpmfile());
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

function hostSdkPnpmfile(): string {
  return `function readPackage(pkg) {
  if (pkg.peerDependencies && pkg.peerDependencies[${JSON.stringify(HOST_SDK)}]) {
    delete pkg.peerDependencies[${JSON.stringify(HOST_SDK)}];
  }
  if (pkg.peerDependenciesMeta && pkg.peerDependenciesMeta[${JSON.stringify(HOST_SDK)}]) {
    delete pkg.peerDependenciesMeta[${JSON.stringify(HOST_SDK)}];
  }
  if (pkg.dependencies && pkg.dependencies[${JSON.stringify(HOST_SDK)}]) {
    delete pkg.dependencies[${JSON.stringify(HOST_SDK)}];
  }
  if (pkg.optionalDependencies && pkg.optionalDependencies[${JSON.stringify(HOST_SDK)}]) {
    delete pkg.optionalDependencies[${JSON.stringify(HOST_SDK)}];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
`;
}
