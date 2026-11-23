import { ParaglideMessage } from "@inlang/paraglide-js-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  isApiError,
  loadSession,
  login,
  logout,
  type AdminPlugin,
  type AdminPublishedModel,
  type ClientApiKey,
  type Connection,
  type ConnectionModel,
  type ConnectionModelCatalog,
  type PublicEndpointType,
  type AuthMethod,
  type CredentialField,
  type GatewayUser,
  type OAuthStart,
  type OperationLog,
  type SubscriptionView,
} from "./api";
import { balanceSummary, BalancesPage } from "./balances";
import { ChannelsPage } from "./channels";
import { ConfirmDialog, useDialogDismiss } from "./dialog";
import { formatDateTime } from "./format";
import { LocaleSwitch } from "./locale-switch";
import { m } from "./paraglide/messages.js";
import { OAuthClientsPage } from "./oauth-clients";
import { PortalApp } from "./portal";
import { PricesPage } from "./prices";
import { RequestsPage } from "./requests";
import { UsersPage } from "./users";

type Page = "plugins" | "connections" | "balances" | "models" | "prices" | "channels" | "users" | "oauth-clients" | "api-keys" | "requests" | "logs";

function keepaliveLabel(status: Connection["keepaliveStatus"]): string {
  if (status === "ok") return m.keepalive_ok();
  if (status === "failed") return m.keepalive_failed();
  if (status === "needs_reauth") return m.keepalive_needs_reauth();
  return status;
}

function logActionLabel(action: string): string {
  if (action === "add") return m.log_action_add();
  if (action === "update") return m.log_action_update();
  if (action === "remove") return m.log_action_remove();
  return action;
}

const PUBLIC_ENDPOINT_TYPES: PublicEndpointType[] = ["openai", "openai-response", "openai-image", "openai-audio", "openai-video"];

function endpointLabel(type: PublicEndpointType): string {
  if (type === "openai") return m.endpoint_chat_completions();
  if (type === "openai-response") return m.endpoint_responses();
  if (type === "openai-image") return m.endpoint_images();
  if (type === "openai-audio") return m.endpoint_audio();
  return m.endpoint_video();
}

function loadedPlugins(plugins: AdminPlugin[]): AdminPlugin[] {
  return plugins.filter((plugin) => plugin.id && plugin.status === "active" && !plugin.error);
}

function defaultFieldValues(method: AuthMethod | undefined): Record<string, string> {
  const next: Record<string, string> = {};
  for (const field of method?.fields ?? []) {
    if (field.defaultValue !== undefined) next[field.key] = field.defaultValue;
  }
  return next;
}

export function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/portal" || path.startsWith("/portal/")) {
    return <PortalApp />;
  }
  return <AdminApp />;
}

function AdminApp() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSession()
      .then((ok) => {
        if (!cancelled) {
          setAuthed(ok);
          setReady(true);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (isApiError(error) && error.status === 503) {
          setDisabled(true);
        } else {
          setBootError(isApiError(error) ? error.message : m.error_load_session());
        }
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return <p className="empty">{m.admin_loading()}</p>;
  }
  if (disabled) {
    return (
      <div className="login-screen">
      <main className="login">
        <div className="login-locale"><LocaleSwitch /></div>
        <h1>{m.admin_disabled_title()}</h1>
        <p>
          <ParaglideMessage
            message={m.admin_disabled_body}
            markup={{ code: ({ children }) => <code>{children}</code> }}
          />
        </p>
      </main>
      </div>
    );
  }
  if (bootError) {
    return (
      <div className="login-screen">
      <main className="login">
        <div className="login-locale"><LocaleSwitch /></div>
        <h1>{m.admin_boot_title()}</h1>
        <p className="banner error">{bootError}</p>
      </main>
      </div>
    );
  }
  if (!authed) {
    return <LoginForm onLoggedIn={() => setAuthed(true)} />;
  }
  return <Console onLogout={() => setAuthed(false)} />;
}

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="login-screen">
    <main className="login">
      <div className="login-locale"><LocaleSwitch /></div>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">V</span>
        <div>
          <div className="brand-name">Viate</div>
          <div className="brand-sub">{m.admin_brand()}</div>
        </div>
      </div>
      <h1>{m.admin_login_title()}</h1>
      <p className="meta">{m.admin_login_subtitle()}</p>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await login(password);
            onLoggedIn();
          } catch (err) {
            setError(isApiError(err) ? err.message : m.error_login());
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {m.label_password()}
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error ? <p className="banner error" role="alert">{error}</p> : null}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? m.busy_signing_in() : m.action_sign_in()}
        </button>
      </form>
    </main>
    </div>
  );
}

const ADMIN_PAGES: Page[] = ["plugins", "connections", "balances", "models", "prices", "channels", "users", "oauth-clients", "api-keys", "requests", "logs"];
const MORE_PAGES: Page[] = ["balances", "prices", "channels", "users", "oauth-clients", "api-keys", "logs"];

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function pageFromPathname(pathname: string): Page {
  const path = normalizePath(pathname);
  if (path === "/" || path === "/admin") return "plugins";
  if (path.startsWith("/admin/")) {
    const page = path.slice("/admin/".length);
    if ((ADMIN_PAGES as readonly string[]).includes(page)) return page as Page;
  }
  return "plugins";
}

function pagePath(page: Page): string {
  return page === "plugins" ? "/admin" : `/admin/${page}`;
}

function Console({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>(() => pageFromPathname(window.location.pathname));
  const [notice, setNotice] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [balanceConnectionId, setBalanceConnectionId] = useState<string | null>(null);
  const [editConnectionId, setEditConnectionId] = useState<string | null>(null);

  function openPage(next: Page) {
    setNotice(null);
    setPage(next);
    setMoreOpen(false);
    const target = pagePath(next);
    if (normalizePath(window.location.pathname) !== target) {
      history.pushState(null, "", target);
    }
  }

  useEffect(() => {
    function onPop() {
      setPage(pageFromPathname(window.location.pathname));
      setNotice(null);
      setMoreOpen(false);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">V</span>
          <div>
            <div className="brand-name">Viate</div>
            <div className="brand-sub">{m.admin_shell_brand()}</div>
          </div>
        </div>
        <nav className="nav" aria-label={m.nav_label()}>
          <NavButton page="plugins" current={page} onClick={openPage}>{m.nav_plugins()}</NavButton>
          <NavButton page="connections" current={page} onClick={openPage}>{m.nav_connections()}</NavButton>
          <NavButton page="balances" current={page} onClick={openPage}>{m.nav_balances()}</NavButton>
          <NavButton page="models" current={page} onClick={openPage}>{m.nav_models()}</NavButton>
          <NavButton page="prices" current={page} onClick={openPage}>{m.nav_prices()}</NavButton>
          <NavButton page="channels" current={page} onClick={openPage}>{m.nav_channels()}</NavButton>
          <NavButton page="users" current={page} onClick={openPage}>{m.nav_users()}</NavButton>
          <NavButton page="oauth-clients" current={page} onClick={openPage}>{m.nav_oauth_clients()}</NavButton>
          <NavButton page="api-keys" current={page} onClick={openPage}>{m.nav_api_keys()}</NavButton>
          <NavButton page="requests" current={page} onClick={openPage}>{m.nav_requests()}</NavButton>
          <NavButton page="logs" current={page} onClick={openPage}>{m.nav_logs()}</NavButton>
        </nav>
        <div className="sidebar-footer">
          <button
            className="ghost"
            type="button"
            onClick={async () => {
              await logout();
              onLogout();
            }}
          >
            {m.action_log_out()}
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <div className="page-heading">
            <h1>{pageLabel(page)}</h1>
            <p className="page-desc">{pageDescription(page)}</p>
          </div>
          <div className="topbar-actions">
            <LocaleSwitch />
            <button
              className="logout-mobile ghost"
              type="button"
              onClick={async () => {
                await logout();
                onLogout();
              }}
            >
              {m.action_log_out()}
            </button>
          </div>
        </div>
        {notice ? <p className="banner ok" role="status">{notice}</p> : null}
        {page === "plugins" ? <PluginsPage onNotice={setNotice} /> : null}
        {page === "connections" ? (
          <ConnectionsPage
            onNotice={setNotice}
            onManageModels={(connectionId) => {
              setSelectedConnectionId(connectionId);
              openPage("models");
            }}
            onOpenBalance={(connectionId) => {
              setBalanceConnectionId(connectionId);
              openPage("balances");
            }}
            editConnectionId={editConnectionId}
            onEditHandled={() => setEditConnectionId(null)}
          />
        ) : null}
        {page === "balances" ? (
          <BalancesPage
            focusId={balanceConnectionId}
            onConfigure={(connectionId) => {
              setEditConnectionId(connectionId);
              openPage("connections");
            }}
          />
        ) : null}
        {page === "models" ? (
          <ModelsPage
            onNotice={setNotice}
            selectedConnectionId={selectedConnectionId}
            onSelectConnection={setSelectedConnectionId}
          />
        ) : null}
        {page === "prices" ? <PricesPage onNotice={setNotice} /> : null}
        {page === "channels" ? <ChannelsPage onNotice={setNotice} /> : null}
        {page === "users" ? <UsersPage onNotice={setNotice} /> : null}
        {page === "oauth-clients" ? <OAuthClientsPage onNotice={setNotice} /> : null}
        {page === "api-keys" ? <ApiKeysPage onNotice={setNotice} /> : null}
        {page === "requests" ? <RequestsPage /> : null}
        {page === "logs" ? <LogsPage /> : null}
      </main>
      <nav className="mobile-nav" aria-label={m.nav_label()}>
        <NavButton page="plugins" current={page} onClick={openPage}>{m.nav_plugins()}</NavButton>
        <NavButton page="connections" current={page} onClick={openPage}>{m.nav_connections()}</NavButton>
        <NavButton page="models" current={page} onClick={openPage}>{m.nav_models()}</NavButton>
        <NavButton page="requests" current={page} onClick={openPage}>{m.nav_requests()}</NavButton>
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-current={MORE_PAGES.includes(page) ? "page" : undefined}
          onClick={() => setMoreOpen(true)}
        >
          {m.nav_more()}
        </button>
      </nav>
      {moreOpen ? <MobileMoreSheet page={page} onClose={() => setMoreOpen(false)} onOpen={openPage} /> : null}
    </div>
  );
}

function MobileMoreSheet({
  page,
  onClose,
  onOpen,
}: {
  page: Page;
  onClose: () => void;
  onOpen: (page: Page) => void;
}) {
  const titleId = useId();
  const panelRef = useDialogDismiss<HTMLDivElement>(onClose);
  return (
    <div
      className="mobile-more-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} className="mobile-more-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="mobile-more-head">
          <h2 id={titleId}>{m.nav_more()}</h2>
          <button type="button" onClick={onClose}>{m.action_close()}</button>
        </div>
        <div className="mobile-more-grid">
          {MORE_PAGES.map((item) => (
            <button
              key={item}
              type="button"
              aria-current={page === item ? "page" : undefined}
              onClick={() => onOpen(item)}
            >
              {navLabel(item)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NavButton({
  page,
  current,
  onClick,
  children,
}: {
  page: Page;
  current: Page;
  onClick: (page: Page) => void;
  children: string;
}) {
  return (
    <a
      href={pagePath(page)}
      aria-current={current === page ? "page" : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onClick(page);
      }}
    >
      {children}
    </a>
  );
}

function navLabel(page: Page): string {
  if (page === "plugins") return m.nav_plugins();
  if (page === "connections") return m.nav_connections();
  if (page === "balances") return m.nav_balances();
  if (page === "models") return m.nav_models();
  if (page === "prices") return m.nav_prices();
  if (page === "channels") return m.nav_channels();
  if (page === "users") return m.nav_users();
  if (page === "oauth-clients") return m.nav_oauth_clients();
  if (page === "api-keys") return m.nav_api_keys();
  if (page === "requests") return m.nav_requests();
  return m.nav_logs();
}

function pageLabel(page: Page): string {
  if (page === "plugins") return m.page_plugins();
  if (page === "connections") return m.page_connections();
  if (page === "balances") return m.page_balances();
  if (page === "models") return m.page_models();
  if (page === "prices") return m.page_prices();
  if (page === "channels") return m.page_channels();
  if (page === "users") return m.page_users();
  if (page === "oauth-clients") return m.page_oauth_clients();
  if (page === "api-keys") return m.page_api_keys();
  if (page === "requests") return m.page_requests();
  return m.page_logs();
}

function pageDescription(page: Page): string {
  if (page === "plugins") return m.page_plugins_desc();
  if (page === "connections") return m.page_connections_desc();
  if (page === "balances") return m.page_balances_desc();
  if (page === "models") return m.page_models_desc();
  if (page === "prices") return m.page_prices_desc();
  if (page === "channels") return m.page_channels_desc();
  if (page === "users") return m.page_users_desc();
  if (page === "oauth-clients") return m.page_oauth_clients_desc();
  if (page === "api-keys") return m.page_api_keys_desc();
  if (page === "requests") return m.page_requests_desc();
  return m.page_logs_desc();
}

function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "error";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function PluginsPage({ onNotice }: { onNotice: (value: string | null) => void }) {
  const [plugins, setPlugins] = useState<AdminPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<AdminPlugin | null>(null);

  async function refresh() {
    const result = await api<{ plugins: AdminPlugin[] }>("/api/admin/plugins");
    setPlugins(result.plugins);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : m.error_load_plugins()));
  }, []);

  const pending = useMemo(() => plugins?.some((plugin) => plugin.restartRequired) ?? false, [plugins]);

  async function updateAdvertisedEndpoints(
    plugin: AdminPlugin,
    type: "openai" | "openai-response" | "openai-image" | "openai-audio" | "openai-video",
    enabled: boolean,
  ) {
    if (!plugin.id) {
      return;
    }
    const current = plugin.advertisedEndpointTypes ?? [];
    const next = (["openai", "openai-response", "openai-image", "openai-audio", "openai-video"] as const).filter((value) =>
      value === type ? enabled : current.includes(value),
    );
    setBusy(true);
    setError(null);
    onNotice(null);
    try {
      const result = await api<{ plugins: AdminPlugin[] }>(
        `/api/admin/providers/${encodeURIComponent(plugin.id)}/advertised-endpoints`,
        {
          method: "PUT",
          body: JSON.stringify({ advertisedEndpointTypes: next }),
        },
      );
      setPlugins(result.plugins);
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_update());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      {pending ? <p className="banner warn">{m.plugins_pending()}</p> : null}
      <form
        className="panel form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          onNotice(null);
          try {
            const result = await api<{ plugins: AdminPlugin[]; log: OperationLog }>("/api/admin/plugins/install", {
              method: "POST",
              body: JSON.stringify({ source }),
            });
            setPlugins(result.plugins);
            setSource("");
            onNotice(result.log.status === "success" ? result.log.message : null);
            if (result.log.status === "failure") {
              setError(result.log.message);
            }
          } catch (err) {
            setError(isApiError(err) ? err.message : m.error_install());
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-header">
          <h2>{m.plugins_install_title()}</h2>
          <p className="meta">{m.plugins_install_hint()}</p>
        </div>
        <label>
          {m.label_plugin_source()}
          <input
            name="source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder={m.plugins_source_placeholder()}
            required
          />
        </label>
        <button className="primary" type="submit" disabled={busy || !source.trim()}>
          {busy ? m.busy_installing() : m.action_install()}
        </button>
      </form>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {plugins === null ? <p className="empty">{m.plugins_loading()}</p> : null}
      {plugins && plugins.length === 0 ? (
        <div className="empty">
          <strong>{m.plugins_empty_title()}</strong>
          {m.plugins_empty_body()}
        </div>
      ) : null}
      {plugins?.map((plugin) => (
        <article className="resource" key={plugin.name}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{plugin.name}</h2>
              <StatusBadge tone={plugin.error ? "error" : plugin.status === "active" ? "ok" : "warn"}>
                {plugin.status === "active" ? m.status_active() : m.status_pending()}
              </StatusBadge>
              {plugin.restartRequired ? <StatusBadge tone="warn">{m.status_restart()}</StatusBadge> : null}
            </div>
            <dl className="meta-list">
              <div><dt>{m.label_version()}</dt><dd>{plugin.version}</dd></div>
              <div><dt>{m.label_source()}</dt><dd>{plugin.source}</dd></div>
              {plugin.id ? <div><dt>{m.label_provider()}</dt><dd>{plugin.id}</dd></div> : null}
            </dl>
            {plugin.id ? (
              <div className="protocol-toggles">
                <p className="meta">{m.plugins_advertised()}</p>
                {PUBLIC_ENDPOINT_TYPES.map((type) => (
                  <label className="toggle" key={type}>
                    <input
                      type="checkbox"
                      checked={plugin.advertisedEndpointTypes.includes(type)}
                      disabled={busy}
                      onChange={(event) => {
                        void updateAdvertisedEndpoints(plugin, type, event.target.checked);
                      }}
                    />
                    {endpointLabel(type)}
                  </label>
                ))}
              </div>
            ) : null}
            {plugin.error ? <div className="status error">{m.plugins_load_error({ error: plugin.error })}</div> : null}
          </div>
          <div className="row-actions">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const result = await api<{ plugins: AdminPlugin[]; log: OperationLog }>("/api/admin/plugins/update", {
                    method: "POST",
                    body: JSON.stringify({ name: plugin.name }),
                  });
                  setPlugins(result.plugins);
                  if (result.log.status === "success") {
                    onNotice(result.log.message);
                  } else {
                    setError(result.log.message);
                  }
                } catch (err) {
                  setError(isApiError(err) ? err.message : m.error_update());
                } finally {
                  setBusy(false);
                }
              }}
            >
              {m.action_update()}
            </button>
            <button className="danger" type="button" disabled={busy} onClick={() => setConfirm(plugin)}>
              {m.action_uninstall()}
            </button>
          </div>
        </article>
      ))}
      {confirm ? (
        <ConfirmDialog
          title={m.plugins_uninstall_title({ name: confirm.name })}
          body={m.plugins_uninstall_body()}
          confirmLabel={m.action_uninstall()}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              const result = await api<{ plugins: AdminPlugin[]; log: OperationLog }>("/api/admin/plugins/remove", {
                method: "POST",
                body: JSON.stringify({ name: confirm.name }),
              });
              setPlugins(result.plugins);
              if (result.log.status === "success") {
                onNotice(result.log.message);
              } else {
                setError(result.log.message);
              }
            } catch (err) {
              setError(isApiError(err) ? err.message : m.error_uninstall());
            } finally {
              setBusy(false);
              setConfirm(null);
            }
          }}
        />
      ) : null}
    </section>
  );
}


function ApiKeysPage({ onNotice }: { onNotice: (value: string | null) => void }) {
  const [keys, setKeys] = useState<ClientApiKey[] | null>(null);
  const [users, setUsers] = useState<GatewayUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ClientApiKey | null>(null);

  async function refresh() {
    const [keyResult, userResult] = await Promise.all([
      api<{ apiKeys: ClientApiKey[] }>("/api/admin/api-keys"),
      api<{ users: GatewayUser[] }>("/api/admin/users"),
    ]);
    setKeys(keyResult.apiKeys);
    setUsers(userResult.users);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : m.error_load_keys()));
  }, []);

  return (
    <section className="stack">
      <article className="panel">
        <div className="panel-header">
          <h2>{m.keys_title()}</h2>
          <p className="meta">{m.keys_hint()}</p>
        </div>
      </article>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {keys === null ? <p className="empty">{m.keys_loading()}</p> : null}
      {keys && keys.length === 0 ? (
        <div className="empty">
          <strong>{m.keys_empty_title()}</strong>
          {m.keys_empty_body()}
        </div>
      ) : null}
      {keys?.map((key) => (
        <article className="resource" key={key.id}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{key.name}</h2>
              <StatusBadge>{key.prefix}…</StatusBadge>
            </div>
            <div className="meta">{m.keys_created({ time: formatDateTime(key.createdAt) })}</div>
            {key.userId ? (
              <div className="meta">{users.find((user) => user.id === key.userId)?.email ?? key.userId}</div>
            ) : null}
          </div>
          <div className="row-actions">
            <button className="danger" type="button" onClick={() => setConfirm(key)}>
              {m.action_revoke()}
            </button>
          </div>
        </article>
      ))}
      {confirm ? (
        <ConfirmDialog
          title={m.keys_revoke_title({ name: confirm.name })}
          body={m.keys_revoke_body()}
          confirmLabel={m.action_revoke()}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await api(`/api/admin/api-keys/${confirm.id}`, { method: "DELETE" });
              await refresh();
              onNotice(m.keys_revoked());
            } catch (err) {
              setError(isApiError(err) ? err.message : m.error_revoke());
            } finally {
              setConfirm(null);
            }
          }}
        />
      ) : null}
    </section>
  );
}

function ConnectionsPage({
  onNotice,
  onManageModels,
  onOpenBalance,
  editConnectionId,
  onEditHandled,
}: {
  onNotice: (value: string | null) => void;
  onManageModels: (connectionId: string) => void;
  onOpenBalance: (connectionId: string) => void;
  editConnectionId: string | null;
  onEditHandled: () => void;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [plugins, setPlugins] = useState<AdminPlugin[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<Connection | null>(null);

  async function refresh() {
    const [connectionResult, pluginResult, subscriptionResult] = await Promise.all([
      api<{ connections: Connection[] }>("/api/admin/connections"),
      api<{ plugins: AdminPlugin[] }>("/api/admin/plugins"),
      api<{ subscriptions: SubscriptionView[] }>("/api/admin/subscriptions"),
    ]);
    setConnections(connectionResult.connections);
    setPlugins(pluginResult.plugins);
    setSubscriptions(subscriptionResult.subscriptions);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : m.error_load_connections()));
  }, []);

  useEffect(() => {
    if (!editConnectionId || !connections) {
      return;
    }
    const connection = connections.find((candidate) => candidate.id === editConnectionId);
    if (connection) {
      setEditing(connection);
    }
    onEditHandled();
  }, [connections, editConnectionId, onEditHandled]);

  return (
    <section className="stack">
      <div className="toolbar">
        <button className="primary" type="button" onClick={() => setCreating(true)}>
          {m.connections_new()}
        </button>
      </div>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {connections === null ? <p className="empty">{m.connections_loading()}</p> : null}
      {connections && connections.length === 0 ? (
        <div className="empty">
          <strong>{m.connections_empty_title()}</strong>
          {m.connections_empty_body()}
        </div>
      ) : null}
      {connections?.map((connection) => {
        const provider = plugins?.find(
          (candidate) => candidate.id === connection.providerId && candidate.status === "active" && !candidate.error,
        );
        const orphan = !provider;
        const subscription = subscriptions?.find((candidate) => candidate.connectionId === connection.id);
        return (
        <article className="resource" key={connection.id}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{connection.displayLabel || connection.providerId}</h2>
              <StatusBadge tone={connection.active ? "ok" : "neutral"}>
                {connection.active ? m.status_active() : m.status_inactive()}
              </StatusBadge>
              <StatusBadge tone={connection.hasCredentials ? "ok" : "warn"}>
                {connection.hasCredentials ? m.status_credentials_saved() : m.status_needs_credentials()}
              </StatusBadge>
              {orphan ? <StatusBadge tone="warn">{m.status_orphan()}</StatusBadge> : null}
            </div>
            <dl className="meta-list">
              <div><dt>{m.label_provider()}</dt><dd>{connection.providerId}</dd></div>
            </dl>
            {connection.keepaliveStatus !== "idle" ? (
              <div className={`status ${connection.keepaliveStatus === "ok" ? "ok" : "warn"}`}>
                {m.keepalive_status({ status: keepaliveLabel(connection.keepaliveStatus) })}{connection.keepaliveError ? ` · ${connection.keepaliveError}` : ""}
              </div>
            ) : null}
            {subscription ? (
              <button className="ghost balance-link" type="button" onClick={() => onOpenBalance(connection.id)}>
                {balanceSummary(subscription)}
              </button>
            ) : null}
          </div>
          <div className="row-actions">
            <button type="button" disabled={orphan} onClick={() => setEditing(connection)}>{m.action_configure()}</button>
            <button
              type="button"
              disabled={orphan || !connection.hasCredentials}
              title={orphan ? m.connections_reinstall_before_models() : !connection.hasCredentials ? m.connections_credentials_before_models() : undefined}
              onClick={() => onManageModels(connection.id)}
            >
              {m.nav_models()}
            </button>
            <button
              type="button"
              disabled={orphan || !connection.hasCredentials}
              title={orphan ? m.connections_reinstall_before_activation() : !connection.hasCredentials ? m.connections_credentials_before_activation() : undefined}
              onClick={async () => {
                try {
                  await api(`/api/admin/connections/${connection.id}/${connection.active ? "deactivate" : "activate"}`, { method: "POST" });
                  await refresh();
                  onNotice(m.connections_now({
                    name: connection.displayLabel || connection.providerId,
                    state: connection.active ? m.status_inactive() : m.status_active(),
                  }));
                } catch (err) {
                  setError(isApiError(err) ? err.message : m.error_activation());
                }
              }}
            >
              {connection.active ? m.connections_deactivate() : m.connections_activate()}
            </button>
            <button className="danger" type="button" onClick={() => setConfirm(connection)}>
              {m.action_delete()}
            </button>
          </div>
        </article>
        );
      })}
      {creating ? (
        <ConnectionDialog
          existing={null}
          plugins={plugins ?? []}
          onCancel={() => setCreating(false)}
          onSaved={async () => {
            await refresh();
            setCreating(false);
            onNotice(m.connections_saved());
          }}
        />
      ) : null}
      {editing ? (
        <ConnectionDialog
          existing={editing}
          plugins={plugins ?? []}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
            setEditing(null);
            onNotice(m.connections_saved());
          }}
        />
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={m.connections_delete_title({ name: confirm.displayLabel || confirm.providerId })}
          body={m.connections_delete_body()}
          confirmLabel={m.action_delete()}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await api(`/api/admin/connections/${confirm.id}`, { method: "DELETE" });
              await refresh();
              onNotice(m.connections_deleted());
            } catch (err) {
              setError(isApiError(err) ? err.message : m.error_delete());
            } finally {
              setConfirm(null);
            }
          }}
        />
      ) : null}
    </section>
  );
}

function ConnectionDialog({
  existing,
  plugins,
  onCancel,
  onSaved,
}: {
  existing: Connection | null;
  plugins: AdminPlugin[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const loaded = loadedPlugins(plugins);
  const initialProviderId = existing?.providerId ?? loaded[0]?.id ?? "";
  const initialMethod = plugins.find((plugin) => plugin.id === initialProviderId)?.authMethods[0];
  const [providerId, setProviderId] = useState(initialProviderId);
  const [methodId, setMethodId] = useState(initialMethod?.id ?? "");
  const [displayLabel, setDisplayLabel] = useState(
    existing && existing.displayLabel !== existing.id ? existing.displayLabel : "",
  );
  const [values, setValues] = useState<Record<string, string>>(() => defaultFieldValues(initialMethod));
  const [oauth, setOAuth] = useState<OAuthStart | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connId, setConnId] = useState<string | null>(existing?.id ?? null);
  const connIdRef = useRef<string | null>(existing?.id ?? null);
  const createdHereRef = useRef(false);
  const closedRef = useRef(false);
  const busyRef = useRef(false);
  const finishingRef = useRef(false);
  const titleId = useId();
  const selectedProviderId = existing?.providerId ?? providerId;
  const plugin = plugins.find((item) => item.id === selectedProviderId) ?? null;
  const methods = plugin?.authMethods ?? [];
  const method = methods.find((item) => item.id === methodId) ?? methods[0];
  const credentialFields = method?.type === "credentials" ? method.fields : [];
  const hasCredentialInput = credentialFields.some((field) => (values[field.key] ?? "") !== (field.defaultValue ?? ""));
  const enforceRequired = method?.type === "oauth" || !existing?.hasCredentials || hasCredentialInput;
  const title = existing
    ? m.credentials_title({
        name: (existing.displayLabel !== existing.id ? existing.displayLabel : "") || existing.providerId,
      })
    : m.connections_new();

  useEffect(() => {
    if (existing || providerId) return;
    const first = loadedPlugins(plugins)[0];
    if (!first?.id) return;
    setProviderId(first.id);
    setMethodId(first.authMethods[0]?.id ?? "");
    setValues(defaultFieldValues(first.authMethods[0]));
  }, [existing, providerId, plugins]);

  function markBusy(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }

  async function dismiss() {
    if (closedRef.current || busyRef.current || finishingRef.current) return;
    closedRef.current = true;
    const id = connIdRef.current;
    if (createdHereRef.current && id) {
      try {
        await api(`/api/admin/connections/${id}?unconfigured=1`, { method: "DELETE" });
      } catch {
        // The dialog still closes if cleanup fails.
      }
    }
    onCancel();
  }

  async function finishSaved() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    createdHereRef.current = false;
    await onSaved();
  }

  const panelRef = useDialogDismiss<HTMLFormElement>(() => {
    void dismiss();
  });

  function selectProvider(id: string) {
    const nextPlugin = plugins.find((item) => item.id === id);
    const nextMethod = nextPlugin?.authMethods[0];
    setProviderId(id);
    setMethodId(nextMethod?.id ?? "");
    setValues(defaultFieldValues(nextMethod));
    setOAuth(null);
    setPasteCode("");
    setError(null);
  }

  function selectMethod(id: string) {
    const next = methods.find((item) => item.id === id);
    setMethodId(id);
    setValues(defaultFieldValues(next));
    setOAuth(null);
    setPasteCode("");
    setError(null);
  }

  async function saveCredentials() {
    if (busyRef.current || !selectedProviderId) return;
    const label = displayLabel.trim();
    const id = connIdRef.current;
    if (!method || method.type !== "credentials") {
      if (!id) return;
      markBusy(true);
      setError(null);
      try {
        await api(`/api/admin/connections/${id}`, {
          method: "PUT",
          body: JSON.stringify({ displayLabel: label }),
        });
        await finishSaved();
      } catch (err) {
        setError(isApiError(err) ? err.message : m.error_save());
        markBusy(false);
      }
      return;
    }
    if (existing?.hasCredentials && !hasCredentialInput) {
      if (!id) return;
      markBusy(true);
      setError(null);
      try {
        await api(`/api/admin/connections/${id}`, {
          method: "PUT",
          body: JSON.stringify({ displayLabel: label }),
        });
        await finishSaved();
      } catch (err) {
        setError(isApiError(err) ? err.message : m.error_save());
        markBusy(false);
      }
      return;
    }
    if (method.fields.some((field) => field.required && !(values[field.key] ?? "").trim())) {
      setError(m.error_credentials_required());
      return;
    }
    const credentials: Record<string, string> = {};
    for (const field of method.fields) credentials[field.key] = values[field.key] ?? "";
    markBusy(true);
    setError(null);
    try {
      if (id === null) {
        await api("/api/admin/connections", {
          method: "POST",
          body: JSON.stringify({
            providerId: selectedProviderId,
            ...(label ? { displayLabel: label } : {}),
            credentials,
          }),
        });
      } else {
        await api(`/api/admin/connections/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            ...(label ? { displayLabel: label } : {}),
            credentials,
          }),
        });
      }
      await finishSaved();
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_save());
      markBusy(false);
    }
  }

  async function connect() {
    if (busyRef.current || !selectedProviderId || method?.type !== "oauth") return;
    const fields = method.fields ?? [];
    if (fields.some((field) => field.required && !(values[field.key] ?? "").trim())) {
      setError(m.error_credentials_required());
      return;
    }
    const label = displayLabel.trim();
    const input: Record<string, string> = {};
    for (const field of fields) input[field.key] = values[field.key] ?? "";
    markBusy(true);
    setError(null);
    try {
      let id = connIdRef.current;
      if (id === null) {
        const created = await api<{ connection: Connection }>("/api/admin/connections", {
          method: "POST",
          body: JSON.stringify({
            providerId: selectedProviderId,
            ...(label ? { displayLabel: label } : {}),
          }),
        });
        id = created.connection.id;
        connIdRef.current = id;
        createdHereRef.current = true;
        setConnId(id);
      }
      const started = await api<OAuthStart>(`/api/admin/connections/${id}/oauth/start`, {
        method: "POST",
        body: JSON.stringify({
          input,
          ...(label ? { displayLabel: label } : {}),
        }),
      });
      setOAuth(started);
      if (started.type === "authorization_url") {
        window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_oauth_start());
    } finally {
      markBusy(false);
    }
  }

  async function exchange() {
    const id = connIdRef.current;
    const code = pasteCode.trim();
    if (busyRef.current || !id || !code) {
      if (!code) setError(m.error_oauth_exchange());
      return;
    }
    markBusy(true);
    setError(null);
    try {
      await api(`/api/admin/connections/${id}/oauth/exchange`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      await finishSaved();
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_oauth_exchange());
      markBusy(false);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void dismiss();
      }}
    >
      <form
        ref={panelRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (method?.type === "oauth") {
            if (oauth?.type === "paste_code") void exchange();
            else if (!oauth) void connect();
            return;
          }
          void saveCredentials();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <p className="meta">{m.credentials_hint()}</p>
        <label>
          {m.connections_loaded_plugin()}
          {existing ? (
            <input value={plugin?.name ?? existing.providerId} readOnly />
          ) : (
            <select value={selectedProviderId} onChange={(event) => selectProvider(event.target.value)} required disabled={connId !== null}>
              {loaded.map((item) => (
                <option key={item.id} value={item.id ?? ""}>{item.name}</option>
              ))}
            </select>
          )}
        </label>
        <label>
          {m.connections_display_name()}
          <input
            value={displayLabel}
            onChange={(event) => setDisplayLabel(event.target.value)}
            placeholder={m.connections_display_name_hint()}
            disabled={oauth !== null}
          />
        </label>
        {loaded.length === 0 && !existing ? <p className="banner warn">{m.connections_picker_empty()}</p> : null}
        {selectedProviderId && methods.length === 0 ? <p className="banner warn">{m.connections_no_auth()}</p> : null}
        {methods.length > 1 ? (
          <div className="segmented" role="group" aria-label={m.credentials_method()}>
            {methods.map((item) => (
              <button key={item.id} type="button" aria-pressed={method?.id === item.id} onClick={() => selectMethod(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
        {method && (method.type === "credentials" || !oauth)
          ? (method.fields ?? []).map((field) => (
              <CredentialFieldInput
                key={`${method.id}:${field.key}`}
                field={field}
                value={values[field.key] ?? ""}
                required={Boolean(field.required) && enforceRequired}
                onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
              />
            ))
          : null}
        {method?.type === "oauth" && busy && !oauth ? <p className="meta">{m.oauth_starting()}</p> : null}
        {method?.type === "oauth" && oauth?.type === "device_code" && connId ? (
          <DeviceCodePanel connectionId={connId} flow={oauth} onComplete={finishSaved} onError={setError} />
        ) : null}
        {method?.type === "oauth" && oauth?.type === "authorization_url" && connId ? (
          <AuthUrlPanel connectionId={connId} url={oauth.authorizationUrl} onComplete={finishSaved} onError={setError} />
        ) : null}
        {oauth?.type === "paste_code" ? (
          <label>
            {m.oauth_code()}
            <textarea value={pasteCode} onChange={(event) => setPasteCode(event.target.value)} rows={4} required />
          </label>
        ) : null}
        {error ? <p className="banner error" role="alert">{error}</p> : null}
        <div className="row-actions">
          {method?.type === "oauth" ? (
            oauth?.type === "paste_code" ? (
              <button className="primary" type="submit" disabled={busy}>
                {busy ? m.busy_saving() : m.oauth_submit_code()}
              </button>
            ) : oauth ? null : (
              <button className="primary" type="submit" disabled={busy || !selectedProviderId}>
                {busy ? m.busy_starting() : m.action_connect()}
              </button>
            )
          ) : (
            <button className="primary" type="submit" disabled={busy || !selectedProviderId || (!existing && !method)}>
              {busy ? m.busy_saving() : m.action_save()}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void dismiss()}>
            {m.action_cancel()}
          </button>
        </div>
      </form>
    </div>
  );
}

function CredentialFieldInput({
  field,
  value,
  required,
  onChange,
}: {
  field: CredentialField;
  value: string;
  required: boolean;
  onChange: (value: string) => void;
}) {
  const control =
    field.kind === "textarea" ? (
      <textarea
        value={value}
        rows={field.rows ?? 4}
        placeholder={field.placeholder}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    ) : field.kind === "select" ? (
      <select value={value} required={required} onChange={(event) => onChange(event.target.value)}>
        {field.required && field.defaultValue ? null : <option value=""></option>}
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ) : (
      <input
        type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"}
        autoComplete={field.kind === "secret" ? "new-password" : undefined}
        value={value}
        placeholder={field.placeholder}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  return (
    <label>
      {field.label}
      {field.description ? <span className="field-hint meta">{field.description}</span> : null}
      {control}
    </label>
  );
}

function DeviceCodePanel({
  connectionId,
  flow,
  onComplete,
  onError,
}: {
  connectionId: string;
  flow: Extract<OAuthStart, { type: "device_code" }>;
  onComplete: () => Promise<void>;
  onError: (value: string | null) => void;
}) {
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let finished = false;
    const timer = window.setInterval(async () => {
      if (cancelled || polling || finished) return;
      polling = true;
      try {
        const result = await api<{ type: "pending" | "complete" | "failed"; error?: string }>(
          `/api/admin/connections/${connectionId}/oauth/poll`,
          { method: "POST" },
        );
        if (cancelled || result.type === "pending") return;
        finished = true;
        window.clearInterval(timer);
        if (result.type === "complete") await onComplete();
        else onError(result.error ?? m.error_oauth());
      } catch (err) {
        if (cancelled || finished) return;
        window.clearInterval(timer);
        onError(isApiError(err) ? err.message : m.error_oauth_poll());
      } finally {
        polling = false;
      }
    }, flow.intervalMs ?? 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connectionId, flow.intervalMs, onComplete, onError]);

  return (
    <div className="banner ok" role="status">
      <ParaglideMessage
        message={m.oauth_device}
        inputs={{ url: flow.verificationUrl, userCode: flow.userCode }}
        markup={{
          link: ({ children, options }) => (
            <a href={String(options.href)} target="_blank" rel="noreferrer">{children}</a>
          ),
          code: ({ children }) => <code>{children}</code>,
        }}
      />
    </div>
  );
}

function AuthUrlPanel({
  connectionId,
  url,
  onComplete,
  onError,
}: {
  connectionId: string;
  url: string;
  onComplete: () => Promise<void>;
  onError: (value: string | null) => void;
}) {
  const [callback, setCallback] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (cancelled || polling) return;
      polling = true;
      try {
        const result = await api<{ connections: Connection[] }>("/api/admin/connections");
        const found = result.connections.find((c) => c.id === connectionId);
        if (found?.hasCredentials && !cancelled) {
          window.clearInterval(timer);
          await onComplete();
        }
      } catch {
        // ignore polling errors
      } finally {
        polling = false;
      }
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connectionId, onComplete]);

  return (
    <>
      <div className="banner ok" role="status">
        <ParaglideMessage
          message={m.oauth_browser}
          inputs={{ url }}
          markup={{
            link: ({ children, options }) => (
              <a href={String(options.href)} target="_blank" rel="noreferrer">{children}</a>
            ),
          }}
        />
      </div>
      <label>
        {m.oauth_callback_paste()}
        <textarea
          value={callback}
          placeholder="http://127.0.0.1:38723/callback?code=…&state=…"
          onChange={(event) => setCallback(event.target.value)}
        />
      </label>
      <div className="row-actions">
        <button
          className="primary"
          type="button"
          disabled={busy || callback.trim() === ""}
          onClick={async () => {
            setBusy(true);
            onError(null);
            try {
              await api(`/api/admin/connections/${connectionId}/oauth/exchange`, {
                method: "POST",
                body: JSON.stringify({ callback }),
              });
              await onComplete();
            } catch (err) {
              onError(isApiError(err) ? err.message : m.error_oauth());
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? m.busy_saving() : m.oauth_callback_finish()}
        </button>
      </div>
    </>
  );
}

function ModelsPage({
  onNotice,
  selectedConnectionId,
  onSelectConnection,
}: {
  onNotice: (value: string | null) => void;
  selectedConnectionId: string | null;
  onSelectConnection: (connectionId: string) => void;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [plugins, setPlugins] = useState<AdminPlugin[] | null>(null);
  const [catalog, setCatalog] = useState<ConnectionModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<"all" | "enabled" | "disabled">("all");
  const [published, setPublished] = useState<AdminPublishedModel[] | null>(null);
  const [customId, setCustomId] = useState("");
  const [customName, setCustomName] = useState("");
  const [customTypes, setCustomTypes] = useState<PublicEndpointType[]>([]);
  const [saving, setSaving] = useState(false);
  const [pendingModelIds, setPendingModelIds] = useState<string[]>([]);
  const [reordering, setReordering] = useState(false);
  const [confirmModel, setConfirmModel] = useState<ConnectionModel | null>(null);
  const writeLock = useRef(false);

  const selected = connections?.find((connection) => connection.id === selectedConnectionId) ?? null;
  const selectedPlugin = plugins?.find((plugin) => plugin.id === selected?.providerId) ?? null;
  const canSync = Boolean(selected && selected.hasCredentials && selectedPlugin?.capabilities.includes("listModels"));

  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ connections: Connection[] }>("/api/admin/connections"),
      api<{ plugins: AdminPlugin[] }>("/api/admin/plugins"),
      api<{ models: AdminPublishedModel[] }>("/api/admin/published-models"),
    ])
      .then(([connectionResult, pluginResult, publishedResult]) => {
        const listed = connectionResult.connections;
        setConnections(listed);
        setPlugins(pluginResult.plugins);
        setPublished(publishedResult.models);
        if (!active) {
          return;
        }
        if (selectedConnectionId && listed.some((connection) => connection.id === selectedConnectionId)) {
          return;
        }
        const fallback = listed.find((connection) => connection.active) ?? listed[0] ?? null;
        if (fallback) {
          onSelectConnection(fallback.id);
        }
      })
      .catch((err) => {
        setError(isApiError(err) ? err.message : m.error_load_connections());
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedConnectionId) {
      setCatalog(null);
      return;
    }
    let cancelled = false;
    setCatalog(null);
    api<ConnectionModelCatalog>(`/api/admin/connections/${selectedConnectionId}/models`)
      .then((result) => {
        if (!cancelled) {
          setCatalog(result);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setCatalog(null);
          setError(isApiError(err) ? err.message : m.error_load_models());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedConnectionId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const models = catalog?.models ?? [];
    return models.filter((model) => {
      if (visibility === "enabled" && !model.enabled) {
        return false;
      }
      if (visibility === "disabled" && model.enabled) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle);
    });
  }, [catalog, query, visibility]);
  const totals = useMemo(() => {
    const models = catalog?.models ?? [];
    const enabled = models.filter((model) => model.enabled).length;
    return { total: models.length, enabled, disabled: models.length - enabled };
  }, [catalog]);
  const filtering = query.trim().length > 0 || visibility !== "all";
  const inventoryLocked = saving || pendingModelIds.length > 0 || reordering;

  async function movePublishedProvider(model: AdminPublishedModel, index: number, delta: number): Promise<void> {
    const next = index + delta;
    if (next < 0 || next >= model.providers.length || writeLock.current) {
      return;
    }
    const providerIds = model.providers.map((provider) => provider.providerId);
    const [moved] = providerIds.splice(index, 1);
    if (!moved) {
      return;
    }
    providerIds.splice(next, 0, moved);
    writeLock.current = true;
    setReordering(true);
    setError(null);
    try {
      const result = await api<{ models: AdminPublishedModel[] }>(
        `/api/admin/published-models/${encodeURIComponent(model.publicId)}/providers`,
        { method: "PUT", body: JSON.stringify({ providerIds }) },
      );
      setPublished(result.models);
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_reorder());
    } finally {
      writeLock.current = false;
      setReordering(false);
    }
  }

  async function setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
    if (!selected || writeLock.current) {
      return;
    }
    writeLock.current = true;
    setPendingModelIds([modelId]);
    setError(null);
    try {
      const result = await api<ConnectionModelCatalog>(
        `/api/admin/connections/${selected.id}/models/${encodeURIComponent(modelId)}`,
        { method: "PUT", body: JSON.stringify({ enabled }) },
      );
      setCatalog(result);
      const publishedResult = await api<{ models: AdminPublishedModel[] }>("/api/admin/published-models");
      setPublished(publishedResult.models);
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_update());
    } finally {
      writeLock.current = false;
      setPendingModelIds([]);
    }
  }

  async function refreshPublished(): Promise<void> {
    const publishedResult = await api<{ models: AdminPublishedModel[] }>("/api/admin/published-models");
    setPublished(publishedResult.models);
  }

  async function addCustomModel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected || writeLock.current) {
      return;
    }
    const id = customId.trim();
    if (!id) {
      return;
    }
    writeLock.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api<ConnectionModelCatalog>(`/api/admin/connections/${selected.id}/models`, {
        method: "POST",
        body: JSON.stringify({
          id,
          ...(customName.trim() ? { name: customName.trim() } : {}),
          endpointTypes: customTypes,
        }),
      });
      setCatalog(result);
      await refreshPublished();
      setCustomId("");
      setCustomName("");
      setCustomTypes([]);
      onNotice(m.models_add_failed_id({ id }));
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_add());
    } finally {
      writeLock.current = false;
      setSaving(false);
    }
  }

  function endpointSelection(model: ConnectionModel): PublicEndpointType[] {
    if (model.endpointTypes && model.endpointTypes.length > 0) {
      return model.endpointTypes;
    }
    return selectedPlugin?.advertisedEndpointTypes ?? [];
  }

  async function setCustomEndpoints(model: ConnectionModel, type: PublicEndpointType, enabled: boolean): Promise<void> {
    if (!selected || writeLock.current) {
      return;
    }
    const current = endpointSelection(model);
    const next = PUBLIC_ENDPOINT_TYPES.filter((id) => (id === type ? enabled : current.includes(id)));
    if (next.length === 0) {
      return;
    }
    writeLock.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api<ConnectionModelCatalog>(
        `/api/admin/connections/${selected.id}/models/${encodeURIComponent(model.id)}/endpoints`,
        { method: "PUT", body: JSON.stringify({ endpointTypes: next }) },
      );
      setCatalog(result);
      await refreshPublished();
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_update());
    } finally {
      writeLock.current = false;
      setSaving(false);
    }
  }

  async function removeCustomModel(modelId: string): Promise<void> {
    if (!selected || writeLock.current) {
      return;
    }
    writeLock.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api<ConnectionModelCatalog>(
        `/api/admin/connections/${selected.id}/models/${encodeURIComponent(modelId)}`,
        { method: "DELETE" },
      );
      setCatalog(result);
      await refreshPublished();
      onNotice(m.models_removed({ id: modelId }));
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_remove());
    } finally {
      writeLock.current = false;
      setSaving(false);
    }
  }

  async function setShownEnabled(enabled: boolean): Promise<void> {
    if (!selected || filtered.length === 0 || writeLock.current) {
      return;
    }
    const modelIds = filtered.map((model) => model.id);
    writeLock.current = true;
    setSaving(true);
    setPendingModelIds(modelIds);
    setError(null);
    try {
      const result = await api<ConnectionModelCatalog>(`/api/admin/connections/${selected.id}/models`, {
        method: "PATCH",
        body: JSON.stringify({ modelIds, enabled }),
      });
      setCatalog(result);
      await refreshPublished();
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_update());
    } finally {
      writeLock.current = false;
      setSaving(false);
      setPendingModelIds([]);
    }
  }

  return (
    <section className="stack">
      <div className="toolbar model-toolbar">
        <label className="connection-picker">
          {m.models_connection()}
          <select
            value={selectedConnectionId ?? ""}
            onChange={(event) => onSelectConnection(event.target.value)}
            disabled={!connections?.length}
          >
            {connections?.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.displayLabel && connection.displayLabel !== connection.providerId
                  ? `${connection.displayLabel} · ${connection.providerId}`
                  : connection.displayLabel || connection.providerId}
                {connection.active ? m.connections_active_suffix() : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          type="button"
          disabled={busy || !canSync}
          title={!selected ? m.models_need_connection() : !selected.hasCredentials ? m.models_credentials_before_sync() : !selectedPlugin?.capabilities.includes("listModels") ? m.models_no_list_title() : undefined}
          onClick={async () => {
            if (!selectedConnectionId) {
              return;
            }
            setBusy(true);
            setError(null);
            try {
              const result = await api<ConnectionModelCatalog>(`/api/admin/connections/${selectedConnectionId}/models/sync`, {
                method: "POST",
              });
              setCatalog(result);
              const publishedResult = await api<{ models: AdminPublishedModel[] }>("/api/admin/published-models");
              setPublished(publishedResult.models);
              onNotice(m.count_models({ count: result.models.length }));
            } catch (err) {
              setError(isApiError(err) ? err.message : m.error_sync());
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? m.busy_syncing() : m.action_sync()}
        </button>
      </div>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {connections === null ? <p className="empty">{m.connections_loading()}</p> : null}
      {connections && connections.length === 0 ? (
        <div className="empty">
          <strong>{m.connections_empty_title()}</strong>
          {m.models_need_sync_body()}
        </div>
      ) : null}
      {selected && !selected.hasCredentials ? (
        <p className="banner warn">{m.models_clear_credentials()}</p>
      ) : null}
      {selected && selected.hasCredentials && selectedPlugin && !selectedPlugin.capabilities.includes("listModels") ? (
        <p className="banner warn">{m.models_no_list()}</p>
      ) : null}
      {connections && connections.length > 0 ? (
        <div className="models-workspace">
          <section className="models-pane" aria-labelledby="model-inventory-title">
            <div className="models-pane-head">
              <div className="models-pane-title">
                <h2 id="model-inventory-title">{m.models_inventory()}</h2>
                <p className="meta">
                  {!catalog ? m.models_inventory_loading() : null}
                  {catalog ? (
                    catalog.syncedAt
                      ? m.models_inventory_synced({ time: formatDateTime(catalog.syncedAt), enabled: String(totals.enabled), total: String(totals.total) })
                      : m.models_inventory_never({ enabled: String(totals.enabled), total: String(totals.total) })
                  ) : null}
                  {catalog && filtering ? m.models_inventory_showing({ count: String(filtered.length) }) : null}
                </p>
              </div>
              <div className="models-pane-tools">
                <label className="model-filter">
                  {m.label_filter()}
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={m.models_filter_placeholder()}
                    type="search"
                  />
                </label>
               <div className="segmented" role="group" aria-label={m.models_status()}>
                 <button type="button" aria-pressed={visibility === "all"} onClick={() => setVisibility("all")}>
                   {m.visibility_all({ count: String(totals.total) })}
                 </button>
                 <button type="button" aria-pressed={visibility === "enabled"} onClick={() => setVisibility("enabled")}>
                   {m.visibility_enabled({ count: String(totals.enabled) })}
                 </button>
                 <button type="button" aria-pressed={visibility === "disabled"} onClick={() => setVisibility("disabled")}>
                   {m.visibility_disabled({ count: String(totals.disabled) })}
                 </button>
                </div>
                <button
                  className="ghost"
                  type="button"
                  disabled={saving || filtered.length === 0 || inventoryLocked}
                  onClick={() => void setShownEnabled(true)}
                >
                  {m.action_enable_shown()}
                </button>
                <button
                  className="ghost"
                  type="button"
                  disabled={saving || filtered.length === 0 || inventoryLocked}
                  onClick={() => void setShownEnabled(false)}
                >
                  {m.action_disable_shown()}
                </button>
              </div>
              <form className="custom-model-form" onSubmit={(event) => void addCustomModel(event)}>
                <label>
                  {m.label_model_id()}
                  <input
                    value={customId}
                    onChange={(event) => setCustomId(event.target.value)}
                    placeholder={m.models_custom_placeholder()}
                    autoComplete="off"
                    disabled={!selected || !catalog || saving}
                    required
                  />
                </label>
                <label>
                  {m.label_name()}
                  <input
                    value={customName}
                    onChange={(event) => setCustomName(event.target.value)}
                    placeholder={m.models_optional()}
                    autoComplete="off"
                    disabled={!selected || !catalog || saving}
                  />
                </label>
                <fieldset className="endpoint-fieldset">
                  <legend>{m.label_endpoints()}</legend>
                  <div className="endpoint-choices">
                    {PUBLIC_ENDPOINT_TYPES.map((type) => (
                      <label key={type} className="endpoint-choice">
                        <input
                          type="checkbox"
                          checked={customTypes.includes(type)}
                          disabled={!selected || !catalog || saving}
                          onChange={(event) => {
                            const enabled = event.target.checked;
                            setCustomTypes(
                              PUBLIC_ENDPOINT_TYPES.filter((id) => (id === type ? enabled : customTypes.includes(id))),
                            );
                          }}
                        />
                        {endpointLabel(type)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button
                  className="primary"
                  type="submit"
                  disabled={!selected || !catalog || saving || !customId.trim() || customTypes.length === 0}
                >
                  {saving ? m.busy_saving() : m.action_add()}
                </button>
              </form>
            </div>
            <div className="model-scroll">
              {!catalog ? (
                <p className="empty">{m.models_loading()}</p>
              ) : catalog.models.length === 0 ? (
                <div className="empty">
                  <strong>{m.models_empty_title()}</strong>
                  {m.models_empty_body()}
                </div>
              ) : filtered.length === 0 ? (
                <div className="empty">
                  <strong>{m.models_no_match_title()}</strong>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setVisibility("all");
                    }}
                  >
                    {m.action_clear_filter()}
                  </button>
                </div>
              ) : (
                <table className="model-table">
                  <caption className="visually-hidden">
                    {m.models_caption({ name: selected?.displayLabel || selected?.providerId || m.models_none() })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{m.label_model()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((model) => (
                      <tr key={model.id} className={model.enabled ? "is-enabled" : undefined}>
                        <td>
                          <div className="model-line">
                            <label className="model-check">
                              <input
                                type="checkbox"
                                checked={model.enabled}
                                disabled={inventoryLocked}
                                aria-label={model.enabled ? m.models_disable({ name: model.name }) : m.models_enable({ name: model.name })}
                                onChange={(event) => {
                                  void setModelEnabled(model.id, event.target.checked);
                                }}
                              />
                              <span className="model-name">
                                <span className={model.name === model.id ? "model-id" : undefined}>{model.name}</span>
                                {model.name !== model.id ? <code>{model.id}</code> : null}
                              </span>
                            </label>
                            {model.custom ? (
                              <span className="model-actions">
                                <span className="endpoint-choices" role="group" aria-label={m.models_endpoints_for({ name: model.name })}>
                                  {PUBLIC_ENDPOINT_TYPES.map((type) => {
                                    const selectedTypes = endpointSelection(model);
                                    const checked = selectedTypes.includes(type);
                                    return (
                                      <label key={type} className="endpoint-choice">
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          disabled={inventoryLocked || (checked && selectedTypes.length === 1)}
                                          aria-label={m.models_endpoint_for({ endpoint: endpointLabel(type), name: model.name })}
                                          onChange={(event) => {
                                            void setCustomEndpoints(model, type, event.target.checked);
                                          }}
                                        />
                                        {endpointLabel(type)}
                                      </label>
                                    );
                                  })}
                                </span>
                                {model.endpointTypes == null ? <span className="meta">{m.status_inherited()}</span> : null}
                                <span className="badge">{m.status_custom()}</span>
                                <button
                                  className="danger"
                                  type="button"
                                  disabled={inventoryLocked}
                                  onClick={() => setConfirmModel(model)}
                                >
                                  {m.action_remove()}
                                </button>
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
          <section className="models-pane" aria-labelledby="published-models-title">
            <div className="models-pane-head">
              <div className="models-pane-title">
                <h2 id="published-models-title">{m.models_published()}</h2>
                <p className="meta">
                  {published === null
                    ? m.models_published_loading()
                    : published.length === 0
                      ? m.models_published_empty()
                      : m.count_public_ids({ count: published.length })}
                  {published?.some((model) => model.providers.length > 1)
                    ? m.models_published_default()
                    : ""}
                </p>
              </div>
            </div>
            <div className="model-scroll">
              {published === null ? (
                <p className="empty">{m.models_published_loading_rows()}</p>
              ) : published.length === 0 ? (
                <div className="empty">
                  <strong>{m.models_published_empty_title()}</strong>
                  {m.models_published_empty_body()}
                </div>
              ) : published.map((model) => (
                <article className="published-row" key={model.publicId}>
                  <div className="published-row-main">
                    <code>{model.publicId}</code>
                    <span className="meta">
                      {model.providers.length === 1 ? model.providers[0]?.providerId : model.ownedBy}
                    </span>
                  </div>
                  {model.providers.length > 1 ? (
                    <div className="published-providers">
                      {model.providers.map((provider, index) => (
                        <div className="published-provider" key={provider.providerId}>
                          <code>{provider.providerId}/{model.publicId}</code>
                          <span className="meta">
                            {provider.connections.map((connection) => connection.displayLabel).join(", ")}
                          </span>
                          <div className="row-actions">
                            <button
                              type="button"
                              disabled={inventoryLocked || index === 0}
                              onClick={() => void movePublishedProvider(model, index, -1)}
                            >
                              {m.models_up()}
                            </button>
                            <button
                              type="button"
                              disabled={inventoryLocked || index === model.providers.length - 1}
                              onClick={() => void movePublishedProvider(model, index, 1)}
                            >
                              {m.models_down()}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {confirmModel ? (
        <ConfirmDialog
          title={m.models_remove_title({ name: confirmModel.name })}
          body={m.models_remove_body()}
          confirmLabel={m.action_remove()}
          busy={saving}
          onCancel={() => {
            if (!saving) setConfirmModel(null);
          }}
          onConfirm={async () => {
            await removeCustomModel(confirmModel.id);
            setConfirmModel(null);
          }}
        />
      ) : null}
    </section>
  );
}

function LogsPage() {
  const [logs, setLogs] = useState<OperationLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ logs: OperationLog[] }>("/api/admin/logs")
      .then((result) => setLogs(result.logs))
      .catch((err) => setError(isApiError(err) ? err.message : m.error_load_logs()));
  }, []);

  return (
    <section className="stack">
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {logs === null ? <p className="empty">{m.logs_loading()}</p> : null}
      {logs && logs.length === 0 ? (
        <div className="empty">
          <strong>{m.logs_empty_title()}</strong>
          {m.logs_empty_body()}
        </div>
      ) : null}
      {logs && logs.length > 0 ? (
        <div className="log-list">
          {logs.map((log) => (
            <article className="log-row" key={log.id}>
              <time dateTime={log.createdAt}>{formatDateTime(log.createdAt)}</time>
              <div className="resource-main">
                <div className="resource-title-row">
                  <h2>{logActionLabel(log.action)}</h2>
                  <StatusBadge tone={log.status === "success" ? "ok" : "error"}>{log.status === "success" ? m.status_success() : m.status_failure()}</StatusBadge>
                  {log.restartRequired ? <StatusBadge tone="warn">{m.status_restart()}</StatusBadge> : null}
                </div>
                <dl className="meta-list">
                  {log.name ? <div><dt>{m.logs_plugin()}</dt><dd>{log.name}</dd></div> : null}
                  {log.source ? <div><dt>{m.label_source()}</dt><dd>{log.source}</dd></div> : null}
                </dl>
                <div className="meta">{log.message}</div>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
