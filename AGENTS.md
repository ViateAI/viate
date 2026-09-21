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

A plugin package.json must include:

```json
{
  "viate": {
    "id": "provider-id",
    "entry": "dist/index.js"
  }
}
```

The entry exports `definePlugin({ id, register })`. `register` calls `ctx.registerProvider(handler)` once. Duplicate provider ids fail load.

`ProviderHandler` may implement `chatCompletions`, `embeddings`, `responses`, `responsesCompact`, `listModels`, `keepalive`, credential form/normalize, and OAuth start/exchange/poll. Return `HttpExchange` for proxied HTTP; do not invent a second protocol layer.

Plugins log through SDK `PluginLogger` (`ctx.log`, `KeepaliveInput.log`). Hosts adapt their logger with `createPluginLogger(write)`. Do not import Fastify or `console` from plugins.

Sibling plugin repos (`viate-plugin-*`) are separate packages. This repo does not vendor them.

## Installer And Data Layout

`$VIATE_DATA_DIR/plugins/`:

- `active/` live workspace loaded at startup
- `pending/` staged after add/update/remove; applied on next start
- `state.json` installed package records
- lock file around mutations

Installer uses `pnpm add|update|remove --workspace-root` with `ignore-scripts=true`. Spawn is argv-only (`shell: false`). Package args must not start with `-`. Installer output redacts credentials/tokens. Subprocess env drops npm/git tokens and secret-shaped `VIATE_*` vars except `VIATE_DATA_DIR` and `VIATE_PNPM`.

CLI and admin share `PluginManager`. Pending means restart required. Load failures are returned as plugin errors, not swallowed.

## HTTP Surface

Public:

- `GET /health` — open, `{ status: "ok" }`
- `POST /v1/chat/completions`
- `GET /v1/models` — OpenAI `{ object: "list", data }` plus proxy fields `supported_endpoint_types` (`openai`, `openai-response`) and optional `name` / `context_length`. Multi-source models keep `children`.
- `POST /v1/embeddings`
- `POST /v1/responses`
- `POST /v1/responses/compact` — Codex-style conversation compaction. Routed like `/v1/responses`; plugins that omit `responsesCompact` return 404 `capability not supported`.

`/v1` requires `Authorization: Bearer` or `x-api-key`. Admin cookies do not authenticate `/v1`. No client keys => `/v1` is 401. Missing/invalid key is 401.

Admin UI: `GET /admin` (SPA from `VIATE_ADMIN_UI_DIST` or a discovered `apps/web/dist`).

Admin API (`/api/admin/*`) requires `VIATE_ADMIN_PASSWORD`. Absent password disables management with 503.

- Login: `POST /api/admin/login` `{password}`
- Session cookie: `viate_admin`, HttpOnly, SameSite=Strict
- CSRF: token in login/session JSON and `viate_csrf` cookie; mutations need Origin/Referer match plus `X-Viate-Csrf`
- `GET /api/admin/session`, `POST /api/admin/logout`
- Plugins: `GET /api/admin/plugins`; `POST /api/admin/plugins/install|update|remove`
- Providers: `PUT /api/admin/providers/:providerId/advertised-endpoints` `{advertisedEndpointTypes}`. Filters `/v1/models` discovery only; `/v1` request routes stay open.
- Logs: `GET /api/admin/logs`
- Connections: `GET/POST /api/admin/connections`; `PUT/DELETE /api/admin/connections/:id`; activate/deactivate; OAuth start/poll/callback; per-connection model sync
- Client keys: `GET/POST /api/admin/api-keys`; `DELETE /api/admin/api-keys/:id`. Secret shown once as `viate_…`; list returns prefix. Store HMAC-SHA256 only.

## Routing And Secrets

Many connections may be enabled. `/v1/models` aggregates enabled models by upstream id. Chat/embeddings/responses/compact route by request model with last-known-good plus session stickiness and failover.

Connection secrets live in SQLite, AES-256-GCM, key file `$VIATE_DATA_DIR/credential.key` mode `0600`. API never returns `apiKey`. Omitted `apiKey` on update keeps the saved secret.

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

Follow `docs/DESIGN.md` (Vercel-like developer console) and `docs/ui-review-checklist.md`. Admin pages: plugins, connections, models, API keys, logs. Keep it a control panel, not a marketing site.

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
