#!/usr/bin/env node
import { defaultDataDir, PluginManager } from "@viateai/plugin-manager";
import { parseArgs } from "./args.js";

async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const dataDir = parsed.dataDir ?? defaultDataDir();
    const manager = new PluginManager({ dataDir });
    switch (parsed.command.kind) {
      case "add": {
        const plugins = await manager.add(parsed.command.source);
        process.stdout.write(`${JSON.stringify({ ok: true, plugins }, null, 2)}\n`);
        return 0;
      }
      case "list": {
        const plugins = await manager.list();
        process.stdout.write(`${JSON.stringify({ plugins }, null, 2)}\n`);
        return 0;
      }
      case "remove": {
        const plugins = await manager.remove(parsed.command.name);
        process.stdout.write(`${JSON.stringify({ ok: true, plugins }, null, 2)}\n`);
        return 0;
      }
      case "update": {
        const plugins = await manager.update(parsed.command.name);
        process.stdout.write(`${JSON.stringify({ ok: true, plugins }, null, 2)}\n`);
        return 0;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
