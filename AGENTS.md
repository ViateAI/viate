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

All installed plugin code is trusted. Code changes take effect on restart; interruptions are acceptable. Uninstall retains connection credentials. Ordinary npm dependencies are allowed; runtime plugin-to-plugin dependencies are not.

## Architecture

TypeScript strict, Node 24 LTS, pnpm workspace.

| Package | Path | Role |
|---|---|---|
| `@viateai/sdk` | `packages/sdk` | Plugin/provider contract. Independent of Fastify and SQLite. |
| `@viateai/plugin-manager` | `packages/plugin-manager` | pnpm-backed install/list/update/remove. Active vs pending workspaces. |
| `@viateai/cli` | `packages/cli` | `viate plugin add\|list\|remove\|update`. |
| `@viateai/server` | `apps/server` | Fastify API, admin, `/v1`, SQLite store. |
| `@viateai/web` | `apps/web` | React/Vite admin UI, production base `/admin/`. |

Persistence: SQLite at `$VIATE_DATA_DIR/viate.sqlite`. Default data dir is `~/.viate`. Docker uses `/data`.

Default listen: `0.0.0.0:4317`.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev          # @viateai/server via tsx watch
pnpm dev:web      # Vite admin on 5173, proxies /api and /health to 4317
pnpm start        # node apps/server/dist/main.js
pnpm viate -- plugin list
```

Node tests use `node --import tsx --test`. There is no ESLint/Prettier toolchain; do not add one unless asked.

Web UI work is not done until the actual `/admin` surface has been exercised (browser or equivalent). Server work is not done until a real process has answered HTTP, not only unit tests.

## Plugin Contract

A plugin `package.json` must include `viate.id` and `viate.entry`. The entry exports `definePlugin({ id, register })`. `register` calls `ctx.registerProvider(handler)` once. Duplicate provider ids fail load.

`ProviderHandler` may implement chat, embeddings, responses, compact, images, audio, video, `listModels`, `keepalive`, credential form/normalize, and OAuth. Proxied calls return `HttpExchange`. Do not invent a second protocol layer. A missing method is 404 `capability not supported`.

Plugins log through SDK `PluginLogger`. Do not import Fastify or `console` from plugins. Sibling `viate-plugin-*` repos are separate packages. This repo does not vendor them.

## Installer

`$VIATE_DATA_DIR/plugins/` holds `active/` (loaded at startup), `pending/` (applied on next start), `state.json`, and a lock around mutations. The installer uses pnpm with `ignore-scripts=true` and argv-only spawn. CLI and admin share `PluginManager`. Pending means restart required.

## HTTP

Public routes are `GET /health`, `GET /` redirecting to `/portal`, and OpenAI-shaped `/v1` for chat, models, embeddings, responses, compact, images, and audio. Video is an xAI-shaped async job, not OpenAI Sora. A video poll uses the connection stored with the submit.

`/v1` accepts `Authorization: Bearer` or `x-api-key` only. Admin cookies do not authenticate `/v1`. No client keys means 401.

A key with no user skips balance and price checks. A bound key checks the channel, then the price, then admission. The channel allows every published model, or an exact model-id list that does not grow when later models are published. It does not name a provider. Routing uses the published connections for that model id. A missing channel, a disallowed model, or a missing price does not admit. Settlement uses the rates captured for that request and, when the key has a channel, its ratio. A captured cache-read price, including zero, charges cache-read tokens at that rate and the remaining input tokens at the input rate. Cache reads above the input count are not billed. No cache-read price leaves those tokens inside the input charge. Cache writes stay in the input bucket.

Admin UI is `GET /admin`. `/api/admin/*` requires `VIATE_ADMIN_PASSWORD` and is 503 without it. Mutations need a same-origin request plus `X-Viate-Csrf`. The admin console does not issue client keys; customers create them at `/portal`.

Advertised endpoint types filter `/v1/models` discovery only. Request routes stay open.

## Secrets

Connection secrets are AES-256-GCM in SQLite. The key file is `$VIATE_DATA_DIR/credential.key`, mode `0600`. The API never returns `apiKey`. Omitting `apiKey` on update keeps the saved secret.

Never commit `.env`, `data/`, `viate.sqlite`, `credential.key`, or plugin workspaces under the data dir.

## Env

| Variable | Purpose |
|---|---|
| `HOST` | Bind address, default `0.0.0.0` |
| `PORT` | Bind port, default `4317` |
| `VIATE_DATA_DIR` | State root, default `~/.viate` |
| `VIATE_ADMIN_PASSWORD` | Enables admin; no insecure default |
| `VIATE_ADMIN_UI_DIST` | Built admin UI directory |
| `VIATE_PNPM` | pnpm binary for the installer |

Do not reintroduce `VIATE_UPSTREAM_*` / `VIATE_PROVIDER_ID` as a hidden builtin provider path. Upstream credentials belong in stored connections.

## UI

Follow `docs/DESIGN.md` and `docs/ui-review-checklist.md`. Keep the admin a control panel, not a marketing site.

## Git And Releases

Do not commit, push, or create a GitHub remote unless the user asks. Intended org is [ViateAI](https://github.com/ViateAI); no remote is authorized yet.

Release Please is wired for `main` (`release-please-config.json`). Do not invent tags or changelog entries by hand.

Keep `PROJECT_BRIEF.txt` and similar local contract notes out of git.

## Editing Guidance

- Prefer existing packages over new ones. Do not precreate empty domain packages.
- Match current style: Node test runner, workspace `workspace:*` deps, no extra frameworks.
- Keep SDK free of Fastify and SQLite imports.
- CLI and Web must keep sharing `PluginManager`; do not fork installer logic.
- Default no install scripts unless the user explicitly approves them.
- Behavior details live in the tests. Do not copy them back into this file.
