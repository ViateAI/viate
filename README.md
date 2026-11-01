# Viate

Gateway for OpenAI-shaped `/v1` traffic. Provider capabilities come from plugins loaded in the server process. The CLI and the admin UI share one installer.

## Requirements

- Node.js `>=24`
- pnpm `9.12.0`

## Local

```bash
pnpm install
export VIATE_ADMIN_PASSWORD='replace-me'
pnpm dev
pnpm dev:web
```

`pnpm dev` is the API. It listens on `0.0.0.0:4317`. There is no default admin password.

`pnpm dev:web` is the Vite admin on port `5173`, base `/admin/`. It proxies `/api` and `/health` to `127.0.0.1:4317`. `/` redirects to `/portal`.

The API serves the admin and portal UI only when a built `index.html` is available. `pnpm dev` does not build that UI. After `pnpm build`, the server finds `apps/web/dist` on its own. Set `VIATE_ADMIN_UI_DIST` to point elsewhere.

```bash
pnpm build
pnpm start
pnpm typecheck
pnpm test
```

`pnpm start` runs the built server (`node apps/server/dist/main.js` via the workspace script).

## Docker

`compose.yaml` builds the local `Dockerfile`. This repo does not publish a registry image.

```bash
export VIATE_ADMIN_PASSWORD='replace-me'
docker compose up -d --build
```

`VIATE_ADMIN_PASSWORD` can also live in a gitignored `.env` beside `compose.yaml`. Compose reads `${VIATE_ADMIN_PASSWORD:-}`. Empty means admin stays disabled.

The image listens on `0.0.0.0:4317`, sets `VIATE_DATA_DIR=/data` and `VIATE_ADMIN_UI_DIST=/app/web`, and publishes `4317`. State is the `viate-data` volume mounted at `/data`. `viate` is on `PATH` inside the image.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `4317` | Bind port. Integer from 1 to 65535 |
| `VIATE_DATA_DIR` | `~/.viate` | State root. Docker uses `/data` |
| `VIATE_ADMIN_PASSWORD` | unset | Enables `/api/admin`. No default |
| `VIATE_ADMIN_UI_DIST` | built UI, if found | Directory that contains admin `index.html` |
| `VIATE_PNPM` | `pnpm` | pnpm binary the installer spawns |

## HTTP

`GET /health` returns `{ "status": "ok" }`.

`GET /` is a 302 to `/portal`. `GET /portal` and `GET /admin` serve the built UI when it is present. `/api/portal` is the customer API and works without the admin password. `/api/admin` is the operator API.

`/v1` routes:

| Method | Path |
| --- | --- |
| `POST` | `/v1/chat/completions` |
| `GET` | `/v1/models` |
| `POST` | `/v1/embeddings` |
| `POST` | `/v1/responses` |
| `POST` | `/v1/responses/compact` |
| `POST` | `/v1/images/generations` |
| `POST` | `/v1/images/edits` |
| `POST` | `/v1/audio/transcriptions` |
| `POST` | `/v1/audio/speech` |
| `POST` | `/v1/videos/generations` |
| `POST` | `/v1/videos/edits` |
| `POST` | `/v1/videos/extensions` |
| `GET` | `/v1/videos/:requestId` |

A provider method that is not implemented returns 404 `capability not supported`.

Video is an xAI-shaped async job, not OpenAI Sora. Submit on the three `POST` routes. A JSON success body with `request_id` is stored with the connection that served it. `GET /v1/videos/:requestId` polls that same connection with `{ "request_id": "<id>" }`.

Advertised endpoint types label `GET /v1/models`. They do not close request routes. Known types are `openai`, `openai-response`, `openai-image`, `openai-audio`, and `openai-video`. The default advertisement is `openai` and `openai-response`.

A channel allows every published model (`all`) or an exact model-id list (`models`). It does not name a provider. Routing uses published connections for that model id. A `models` list does not grow when later models are published.

## Authentication

`/v1` accepts `Authorization: Bearer <key>` or `x-api-key`. Admin and portal cookies do not authenticate `/v1`. A missing key, an unknown key, or a data directory with no client keys returns 401 `invalid api key`.

Customers create client keys at `/portal` (`POST /api/portal/keys`). Admin can list and delete keys. It does not issue them.

Without `VIATE_ADMIN_PASSWORD`, every `/api/admin` route returns 503:

```json
{ "error": { "message": "admin management is disabled", "type": "viate_error" } }
```

Admin and portal mutations need a same-origin request and an `X-Viate-Csrf` header. Login needs a same-origin request. The check compares `Origin` to `X-Forwarded-Proto` (or the request protocol) plus `Host`. A public HTTPS proxy must forward `Host` and `X-Forwarded-Proto`.

A key with no user skips balance and price checks. A key bound to a user checks the channel, then the price, then admission. A missing channel, a disallowed model, or a missing price does not admit.

## Cookies

Session cookies are `HttpOnly`, `SameSite=Strict`, and not `Secure`. `Max-Age` is 12 hours. Names are `viate_admin`, `viate_csrf`, `viate_user`, and `viate_user_csrf`.

`Secure` is unset, so a browser will send these cookies on plain HTTP. Put a public deployment behind an HTTPS reverse proxy.

## Plugins

Do not install plugins you do not trust. Plugins execute in-process as trusted code. Install uses `ignore-scripts=true`. That does not make an untrusted plugin safe.

A plugin `package.json` needs `viate.entry`. Also set `viate.id`:

```json
{
  "name": "@example/your-plugin",
  "type": "module",
  "viate": {
    "id": "your-provider",
    "entry": "index.js"
  }
}
```

Install rejects a package with no `viate.entry`. The entry must export `definePlugin({ id, register })` from `@viateai/sdk` as the default export, the named `plugin` export, or the module itself. `register` must call `ctx.registerProvider` once. The provider `id` must equal the plugin `id`. A duplicate plugin id fails to load. Log through `ctx.log`.

`@viateai/sdk` is the host SDK. The installer removes it from the plugin dependency set so pnpm does not install a second copy.

`add`, `update`, and `remove` stage a pending workspace. The server applies it on the next start. Until then the previous active set stays loaded.

## CLI

Subcommands are `plugin list`, `plugin add <source>`, `plugin remove <name>`, and `plugin update <name>`. `--data-dir <path>` (or `--data-dir=<path>`) overrides the data directory for that invocation. `<source>` is passed to `pnpm add`. `<name>` is the installed package name and must not start with `-`.

The repo script is `pnpm viate`, which runs `pnpm --filter @viateai/cli run viate --`. On pnpm 9.12.0 these do not reach the parser:

```bash
pnpm viate -- plugin list
pnpm viate -- plugin add <source>
pnpm viate -- plugin remove <name>
pnpm viate -- plugin update <name>
```

`pnpm viate -- plugin list` becomes `node dist/main.js "--" "--" "plugin" "list"`. The parser requires the first argument to be `plugin`, so a leading `--` is a usage error. `pnpm viate plugin list` still inserts one `--`.

After `pnpm build`, call the built entry. This argv is `plugin list` with no leading `--`:

```bash
pnpm --filter @viateai/cli exec node dist/main.js plugin list
pnpm --filter @viateai/cli exec node dist/main.js plugin add <source>
pnpm --filter @viateai/cli exec node dist/main.js plugin remove <name>
pnpm --filter @viateai/cli exec node dist/main.js plugin update <name>
pnpm --filter @viateai/cli exec node dist/main.js --data-dir <path> plugin list
```

In the image, `viate` is the built entry on `PATH`, not the pnpm script: `viate plugin list`.

## Data

Default data directory is `~/.viate`. Docker uses `/data`.

- SQLite: `$VIATE_DATA_DIR/viate.sqlite`
- Connection secrets: AES-256-GCM, key file `$VIATE_DATA_DIR/credential.key`, mode `0600`
- Plugin install state: `$VIATE_DATA_DIR/plugins/` (`active/`, `pending/`, `state.json`, lock)

The admin connection list returns `hasCredentials`, not the secret.

## Layout

| Path | Package |
| --- | --- |
| `apps/server` | `@viateai/server` |
| `apps/web` | `@viateai/web` |
| `packages/sdk` | `@viateai/sdk` |
| `packages/plugin-manager` | `@viateai/plugin-manager` |
| `packages/cli` | `@viateai/cli` |

## License

MIT. See [LICENSE](LICENSE).
