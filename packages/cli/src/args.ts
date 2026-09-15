export type PluginCommand =
  | { kind: "add"; source: string }
  | { kind: "list" }
  | { kind: "remove"; name: string }
  | { kind: "update"; name: string };

export type ParsedArgs = {
  dataDir?: string;
  command: PluginCommand;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--data-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--data-dir requires a path");
      }
      dataDir = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--data-dir=")) {
      const value = token.slice("--data-dir=".length);
      if (!value) {
        throw new Error("--data-dir requires a path");
      }
      dataDir = value;
      continue;
    }
    rest.push(token);
  }

  if (rest[0] !== "plugin") {
    throw new Error("usage: viate [--data-dir <path>] plugin <add|list|remove|update> …");
  }

  const sub = rest[1];
  if (sub === "list") {
    if (rest.length !== 2) {
      throw new Error("usage: viate plugin list");
    }
    return { dataDir, command: { kind: "list" } };
  }
  if (sub === "add") {
    if (!rest[2] || rest.length !== 3) {
      throw new Error("usage: viate plugin add <source>");
    }
    return { dataDir, command: { kind: "add", source: requirePackageArg(rest[2], "source") } };
  }
  if (sub === "remove") {
    if (!rest[2] || rest.length !== 3) {
      throw new Error("usage: viate plugin remove <name>");
    }
    return { dataDir, command: { kind: "remove", name: requirePackageArg(rest[2], "name") } };
  }
  if (sub === "update") {
    if (!rest[2] || rest.length !== 3) {
      throw new Error("usage: viate plugin update <name>");
    }
    return { dataDir, command: { kind: "update", name: requirePackageArg(rest[2], "name") } };
  }
  throw new Error("usage: viate [--data-dir <path>] plugin <add|list|remove|update> …");
}

function requirePackageArg(value: string, kind: "source" | "name"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${kind} is required`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`${kind} must not start with "-"`);
  }
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
    throw new Error(`invalid ${kind}`);
  }
  return trimmed;
}
