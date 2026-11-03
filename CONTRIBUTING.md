# Contributing

## Requirements

Node.js >= 24. pnpm 12.16.1, pinned by `package.json` `packageManager`. Use Corepack (`corepack enable`) so the pinned pnpm is used. Do not use pnpm 9.

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`apps/web` typecheck and build compile Paraglide messages first (`i18n:compile`). Do not commit `apps/web/src/paraglide/`; it is gitignored.

## Providers

Upstream provider implementations do not belong in this repo. A provider is a separate package. Its `package.json` needs `viate.id` and `viate.entry`. The entry exports `definePlugin({ id, register })`, and `register` calls `ctx.registerProvider` once. Plugins run in-process as trusted code. Do not install a plugin you do not trust.

## Pull requests

Pull requests target `main`. CI runs typecheck, test, and build.

## Releases

Release Please owns versions and `CHANGELOG.md`. Do not edit version fields or `CHANGELOG.md` by hand. `feat:`, `fix:`, and `perf:` commits on `main` open a Release PR. The first of those from 0.0.0 becomes 0.1.0 (`bump-minor-pre-major`). `docs:`, `ci:`, `chore:`, and `refactor:` do not bump.

Runtime and admin setup stay in [README.md](README.md). This file does not repeat the route or billing rules.
