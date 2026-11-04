# AGENTS.md

Guidance for AI coding agents working in `viate`.

## Project Intent

Viate is an independent AI gateway. Provider capabilities are flat trusted plugins: registration, credentials/connections, requests, conversion, streaming, cleanup. CLI and Web share one installer. Containers ship a Web admin.

Not a marketplace. Installed plugins show name, version, source, status, and errors, plus install/update/remove logs.

Do not add:

- sandboxing, a permissions system, or a plugin dependency graph
- workflow/node properties, compatibility shims, multi-version runtime, or hot replacement
- a plugin marketplace
- microservices, Redis, a Go/Rust rewrite, or Cordis
- empty domain packages ahead of a real consumer

All installed plugin code is trusted. Plugin code changes take effect on restart; interruptions are acceptable. Uninstall retains connection credentials. Ordinary npm dependencies are allowed; runtime plugin-to-plugin dependencies are not.

## Architecture

TypeScript strict, Node 24 LTS, pnpm workspace. pnpm is pinned in the root `package.json`; do not use another major.

| Package | Path | Role |
|---|---|---|
| `@viateai/sdk` | `packages/sdk` | Plugin/provider contract. Independent of Fastify and SQLite. |
| `@viateai/plugin-manager` | `packages/plugin-manager` | pnpm-backed install/list/update/remove. Active vs pending workspaces. |
| `@viateai/cli` | `packages/cli` | `viate plugin add\|list\|remove\|update`. |
| `@viateai/server` | `apps/server` | Fastify API, admin, portal, `/v1`, SQLite store. |
| `@viateai/web` | `apps/web` | React/Vite admin and portal UI. Production base `/admin/`. Hand-written CSS. Paraglide for messages. |

Persistence: SQLite at `$VIATE_DATA_DIR/viate.sqlite`. Default data dir is `~/.viate`. Docker uses `/data`.

Default listen: `0.0.0.0:4317`.

HTTP surface, Docker, and env defaults live in `README.md`. Do not copy them into this file.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev          # @viateai/server via tsx watch
pnpm dev:web      # Vite on 5173, proxies /api and /health to 4317
pnpm start        # built server
pnpm viate -- plugin list
```

Node tests use `node --import tsx --test`. There is no ESLint/Prettier toolchain; do not add one unless asked.

`apps/web` typecheck and build compile Paraglide first. Do not commit `apps/web/src/paraglide/`.

Web UI work is not done until the changed surface has been exercised (browser or equivalent): `/admin` for the admin console, `/portal` for the customer portal. Server work is not done until a real process has answered HTTP, not only unit tests.

## Boundaries

- Plugin `package.json` needs `viate.entry`. The entry exports `definePlugin({ id, register })`. `register` calls `ctx.registerProvider` once. Provider id must equal plugin id. Duplicate plugin ids are rejected. A bad plugin is reported and skipped; it must not take down the process.
- `ProviderHandler` methods are the only capabilities, including ones added later such as `subscription`. Proxied calls return `HttpExchange`. A missing method is 404 `capability not supported`. Do not invent a second protocol layer. Video stays the xAI-shaped async job, not OpenAI Sora.
- Plugins log through SDK `PluginLogger`. Do not import Fastify, SQLite, or `console` from plugins. Sibling `viate-plugin-*` repos stay separate. This repo does not vendor them.
- `$VIATE_DATA_DIR/plugins/` has `active/` (loaded at startup) and `pending/` (applied on next start). The installer uses pnpm with `ignore-scripts=true` and argv-only spawn. CLI and admin share `PluginManager`. Do not fork installer logic. Pending means restart required.
- `/v1` accepts `Authorization: Bearer` or `x-api-key` only. Admin and portal cookies do not authenticate `/v1`. No client keys means 401.
- Advertised endpoint types filter `/v1/models` discovery only. Request routes stay open.
- Admin UI is `GET /admin`. `/api/admin/*` is 503 without `VIATE_ADMIN_PASSWORD`. Mutations need a same-origin request plus `X-Viate-Csrf`. The admin console does not issue client keys; customers create them at `/portal`.
- Connection secrets are AES-256-GCM in SQLite. The key file is `$VIATE_DATA_DIR/credential.key`, mode `0600`. The API never returns `apiKey`.
- Never commit `.env`, `data/`, `viate.sqlite`, `credential.key`, or plugin workspaces under the data dir.
- Do not reintroduce `VIATE_UPSTREAM_*` / `VIATE_PROVIDER_ID`. Upstream credentials belong in stored connections.

## UI

Match the visual rules in `docs/DESIGN.md` and `docs/ui-review-checklist.md`. Keep the admin a monochrome control panel, not a marketing site. Keep that visual direction if the UI is later rebuilt.

Extend the hand-written CSS in `apps/web/src/styles.css`. Do not add Tailwind, shadcn, Radix, or an icon library during ordinary feature work.

`docs/DESIGN.md` names that stack as a later implementation option. Use it only for a dedicated UI refactor, when hand-written interactive behavior such as dialogs, focus handling, menus, and layering is no longer worth maintaining. More pages are not that reason. The visual direction stays the same across that change.

## Git And Releases

Do not commit, push, or create a GitHub remote unless the user asks. Intended org is [ViateAI](https://github.com/ViateAI); no remote is authorized yet.

Release Please is wired for `main` (`release-please-config.json`). Do not invent tags, version fields, or changelog entries by hand.

Keep `PROJECT_BRIEF.txt` and similar local contract notes out of git.

## Editing

- Prefer existing packages over new ones. Do not precreate empty domain packages.
- Match current style: Node test runner, workspace `workspace:*` deps. Do not add a framework unless the UI section allows that refactor.
- Keep SDK free of Fastify and SQLite imports.
- Default no install scripts unless the user explicitly approves them.
- Behavior details live in the tests and `README.md`. Do not copy them back into this file.
