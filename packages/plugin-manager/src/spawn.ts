import { spawn } from "node:child_process";
import { redactInstallerOutput } from "./source.js";

export type SpawnResult = {
  status: number;
  stdout: string;
  stderr: string;
};

const KEEP_VIATE: Record<string, true> = {
  VIATE_DATA_DIR: true,
  VIATE_PNPM: true,
};

const DROP_ENV: Record<string, true> = {
  NPM_TOKEN: true,
  NODE_AUTH_TOKEN: true,
  GIT_ASKPASS: true,
  GH_TOKEN: true,
  GITHUB_TOKEN: true,
  GIT_TOKEN: true,
  PNPM_TOKEN: true,
};

export function pluginSubprocessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { npm_config_ignore_scripts: "true" };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || DROP_ENV[key]) {
      continue;
    }
    if (key.startsWith("VIATE_") && !KEEP_VIATE[key] && /PASSWORD|SECRET|TOKEN|KEY|AUTH|CREDENTIAL/i.test(key)) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SpawnResult> {
  const { promise, resolve, reject } = Promise.withResolvers<SpawnResult>();
  const child = spawn(command, args, {
    cwd,
    env: pluginSubprocessEnv(env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (status) => {
    resolve({ status: status ?? 1, stdout, stderr });
  });
  return promise;
}

export async function runPnpm(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SpawnResult> {
  const command = env.VIATE_PNPM?.trim() || "pnpm";
  const result = await runCommand(command, args, cwd, env);
  if (result.status !== 0) {
    const detail = redactInstallerOutput((result.stderr || result.stdout || "").replace(/\s+/g, " ").trim()).slice(
      0,
      300,
    );
    throw new Error(
      detail ? `plugin command failed (${result.status}): ${detail}` : `plugin command failed (${result.status})`,
    );
  }
  return result;
}
