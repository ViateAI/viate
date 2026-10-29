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

`ProviderHandler` may implement `chatCompletions`, `embeddings`, `responses`, `responsesCompact`, `imageGenerations`, `imageEdits`, `audioTranscriptions`, `audioSpeech`, `videoGenerations`, `videoEdits`, `videoExtensions`, `videoResult`, `listModels`, `keepalive`, credential form/normalize, and OAuth start/exchange/poll. Return `HttpExchange` for proxied HTTP; do not invent a second protocol layer.

The four video methods take `JsonPostRequest` and a `ProviderConnection`. The three submit methods convert gateway media (`image`, `last_frame`, `reference_images`, `keyframes`, `video`, `reference_audios` as a URL string, `{ url }`, `{ image_url }`, `{ file_id }`, `{ voice_id }`, or `{ b64_json, media_type? }`) into the provider's own upload shape and pass other JSON fields through. A successful submit body is `{ request_id: string }`. `videoResult` reads `request_id` from the request body; the gateway puts it there.

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
- `GET /` and `HEAD /` — 302 to `/portal`, preserving the query string. Registered only when the admin UI dist is present.
- `POST /v1/chat/completions`
- `GET /v1/models` — OpenAI `{ object: "list", data }` plus proxy fields `supported_endpoint_types` (`openai`, `openai-response`, `openai-image`, `openai-audio`, `openai-video`) and optional `name` / `context_length`. Multi-source models keep `children`.
- `POST /v1/embeddings`
- `POST /v1/responses`
- `POST /v1/responses/compact` — Codex-style conversation compaction. Routed like `/v1/responses`; plugins that omit `responsesCompact` return 404 `capability not supported`.
- `POST /v1/images/generations` and `POST /v1/images/edits` — OpenAI Images routes. Edits accept JSON or `multipart/form-data`; the gateway inlines files as `{ images: [{ b64_json, media_type }] }` before routing. Plugins that omit the method return 404 `capability not supported`.
- `POST /v1/audio/transcriptions` and `POST /v1/audio/speech` — OpenAI speech routes. Transcriptions accept `multipart/form-data`; the gateway inlines the file as `{ file: { b64_json, media_type } }` plus `model`, `language`, and other text fields before routing. Missing file or model is 400. Speech accepts JSON `{ model, input, voice, response_format?, speed? }`. Missing `model`, `input`, or `voice` is 400. Plugins that omit `audioTranscriptions` or `audioSpeech` return 404 `capability not supported`. Responses are upstream bytes (transcription JSON or `text/plain`, speech audio) forwarded with status and content-type. Request logs redact audio bytes the same way image logs redact `b64_json`.
- `POST /v1/videos/generations`, `POST /v1/videos/edits`, `POST /v1/videos/extensions`, and `GET /v1/videos/:requestId` — xAI-shaped async video jobs, not OpenAI Sora. Submits accept JSON or `multipart/form-data`; the gateway inlines `image` / `last_frame` / `video` as one `{ b64_json, media_type }`, `reference_images` / `reference_audios` as arrays of those, parses JSON object or array text fields (`keyframes`), and makes `duration` / `seconds` numbers. Submits route, admit, and settle like images, then, when upstream is 2xx JSON with a string `request_id`, the job row (connection, provider, request model, bound user or key) is saved before the same JSON is forwarded, so a poll can never outrun it. `GET /v1/videos/:requestId` needs a client key, serves only the submitting user (or the submitting key when unbound, else 403), replays `{ request_id }` to `videoResult` on the stored connection with no rewrite, failover, pricing, or admission, forwards upstream JSON including `video.url`, and logs as `videos.result`. An unknown id, a removed connection, or cleared credentials is 404 `unknown video request`; an inactive connection with credentials still polls. Job rows older than 7 days are dropped on the next save. Plugins that omit a method return 404 `capability not supported`.

`/v1` requires `Authorization: Bearer` or `x-api-key`. Admin cookies do not authenticate `/v1`. No client keys => `/v1` is 401. Missing/invalid key is 401. Keys with `user_id` NULL stay unbound: no balance check and no model-price lookup. A bound key on `GET /v1/models` only checks that the user is active (balance 0 may list models; disabled is 403). A key with no channel sees the full published catalog. A key bound to a channel sees only models that channel allows. A registered `/v1` route other than models, after the body is accepted and audio fields validate, rejects a non-empty model outside that channel with 403 `model not available` and does not admit. A missing channel, or a channel the key's user no longer has, is 403 `channel not available`. A match rule can require a provider id, a model-id prefix, an excluded prefix, and chat routes only. When the rule names a provider, routing uses only that provider's published connections. It then prices a non-empty model from the models.dev catalog before admission. A missing or not-ready catalog is 503 `model prices unavailable`. Without its own row, a trailing `fast` suffix is twice the base model price. Thinking-level suffixes (`low`, `medium`, `high`, `xhigh`, `max`) and `-thinking` use the base price. Any other non-empty model with no price is 400 `model price unavailable`. `GET/PUT /api/admin/model-prices` and `DELETE /api/admin/model-prices/*` store a manual price that overrides models.dev and is kept across catalog refresh. A per-request price charges that USD amount once for a successful call and ignores token usage. Video submits are priced the same way: a bound key needs a models.dev row or a manual price, including a per-request override, or the submit is 400 `model price unavailable`; there is no per-second video billing, and polling a job is neither priced nor admitted. Those denials do not reserve a slot. Admission then requires the user to be active, `balance_nano > 0`, and `inflight < 8` (402 `insufficient balance`, 403 `user disabled`). Rejected JSON and unknown `/v1` paths do not reserve a slot. Admission holds until usage is settled from the consumed upstream response, not merely when headers are sent. Settlement deducts nano-USD for actual input+output tokens once per request id, using the rates captured for that request, multiplies that total by the key's channel ratio when the key has a channel, and ignores cache tokens. The ratio is an integer numerator and denominator. `0.1` is `1/10` and `7` is `7/1`. Rounding is half up on the nano-USD total. Prices come from `https://models.dev/api.json` (`cost.input` and `cost.output` are USD per 1,000,000 tokens). The balance is an integer nano-USD amount (1 USD = 1_000_000_000). One in-flight response may drive the balance negative.

Admin UI: `GET /admin` (SPA from `VIATE_ADMIN_UI_DIST` or a discovered `apps/web/dist`).

Admin API (`/api/admin/*`) requires `VIATE_ADMIN_PASSWORD`. Absent password disables management with 503.

- Login: `POST /api/admin/login` `{password}`
- Session cookie: `viate_admin`, HttpOnly, SameSite=Strict
- CSRF: token in login/session JSON and `viate_csrf` cookie; mutations need Origin/Referer match plus `X-Viate-Csrf`
- `GET /api/admin/session`, `POST /api/admin/logout`
- Plugins: `GET /api/admin/plugins`; `POST /api/admin/plugins/install|update|remove`
- Providers: `PUT /api/admin/providers/:providerId/advertised-endpoints` `{advertisedEndpointTypes}`. Filters `/v1/models` discovery only; `/v1` request routes stay open.
  Types are `openai`, `openai-response`, `openai-image`, `openai-audio`, and `openai-video`. Unset providers advertise the first two.
- Logs: `GET /api/admin/logs`
- Requests: `GET /api/admin/requests` (filters, `before` cursor, no bodies) and `GET /api/admin/requests/:id`. `GET /api/admin/requests/stats` keeps `?window=` unless `from`, `to`, or a dimension filter is set, then aggregates that range from `request_logs`.
- Connections: `GET/POST /api/admin/connections`; `PUT/DELETE /api/admin/connections/:id`; activate/deactivate; OAuth start/poll/callback; per-connection model sync. `POST /api/admin/connections/:id/models` `{id, name?}` adds an enabled custom model the upstream list does not contain. `DELETE /api/admin/connections/:id/models/:modelId` removes a custom row only. Sync keeps custom rows whose ids are absent from the upstream list, including name, enabled, and the custom flag. An id the upstream later returns becomes a normal synced row.
- Client keys: `GET /api/admin/api-keys`; `DELETE /api/admin/api-keys/:id`. The admin console does not issue client keys; customers create them at `/portal`. List returns the prefix. Store HMAC-SHA256 only. List rows include `userId` and `channelId`.
- Channels: `GET/POST /api/admin/channels`; `PUT/DELETE /api/admin/channels/:id`. Body `{name, ratio, rule}`. `ratio` is a positive decimal with up to 4 places. `rule` is `{kind:"all"}` or `{kind:"match", providerId, prefix, excludePrefix, chatOnly}`. A match needs at least one constraint. There are no seeded channels. Delete is 409 `channel in use` while a key or customer grant points at it. `GET/PUT /api/admin/users/:id/channels` `{channelIds: string[]}`. An empty list is valid. A new customer has none.
- Users: `POST /api/admin/users` `{email,name,password}`; `GET /api/admin/users`; `PATCH /api/admin/users/:id` `{name?,status?,password?}`; `POST /api/admin/users/:id/balance` `{usd,note?}`; `GET /api/admin/users/:id/ledger`. `usd` is a decimal string. Public JSON uses `balanceUsd`, `deltaUsd`, and `balanceAfterUsd`. Stored amounts are integer nano-USD. The admin password provisions customers. No public signup and no customer delete. Opening a database that already has customers or keys and no `channels` table creates two ordinary channels: Grok at `0.1` matching provider `xai`, prefix `grok-`, excluding `grok-imagine`, chat only; Standard at `7` for every published model. Existing customers are granted only Grok. Existing keys, including unbound keys, are bound to Grok.
- Customer portal page: `GET /portal` and `GET /portal/*` serve the admin `index.html` shell. Assets stay at `/admin/assets/`. `/admin/portal` is not a portal alias. API is `/api/portal/login|logout|session|password|keys|usage|channels`. Cookies `viate_user` and `viate_user_csrf` (HttpOnly, SameSite=Strict, 12h). Portal does not require `VIATE_ADMIN_PASSWORD`. Login is rate limited per IP. Mutations need Origin/Referer match plus `X-Viate-Csrf`. A customer sees the USD balance, ledger, recent request logs, the channels granted to them, and only their own keys. `POST /api/portal/keys` `{name, channelId}` requires a granted channel. Portal cannot grant a balance or create a channel.

## Routing And Secrets

Many connections may be enabled. `/v1/models` aggregates enabled models by upstream id. Publishing stays the connection gate. A key's channel then narrows that catalog. Chat, embeddings, responses, compact, images, audio, and video submits route by request model with last-known-good plus session stickiness and failover; a video poll goes straight to the connection stored with the job. Channel membership is enforced before price lookup and admission.

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
