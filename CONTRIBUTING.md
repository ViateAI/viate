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

Release Please owns versions and changelogs. Do not edit version fields or changelog files by hand.

The gateway (`.`) and `@viateai/sdk` (`packages/sdk`) release separately. Gateway tags are `vX.Y.Z`. They update the root `CHANGELOG.md` and the versions of the root package, `apps/server`, `apps/web`, `packages/cli`, and `packages/plugin-manager`, and they publish the container image. SDK tags are `sdk-vX.Y.Z`. They update `packages/sdk/CHANGELOG.md` and `packages/sdk/package.json`, and they publish `@viateai/sdk`. Versions already released through 1.0.1 stay in the root changelog.

`feat:`, `fix:`, and `perf:` commits on `main` open a Release PR for each component whose paths they touch. A commit that only changes `packages/sdk` does not release the gateway. A commit that also changes any other path releases both. `!` applies to every component that includes the commit, so a breaking SDK change that should not bump the gateway has to be its own commit. `docs:`, `ci:`, `chore:`, and `refactor:` do not bump. Below 1.0.0, breaking changes bump the minor (`bump-minor-pre-major`).

Runtime and admin setup stay in [README.md](README.md). This file does not repeat the route or billing rules.
