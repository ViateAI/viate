import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
  type ConnectionModelCatalog,
  type CredentialField,
  type GatewayUser,
  type OAuthStart,
  type OperationLog,
  type SubscriptionView,
} from "./api";
import { balanceSummary, BalancesPage } from "./balances";
import { ChannelsPage } from "./channels";
import { PortalApp } from "./portal";
import { PricesPage } from "./prices";
import { RequestsPage } from "./requests";
import { UsersPage } from "./users";

type Page = "plugins" | "connections" | "balances" | "models" | "prices" | "channels" | "users" | "api-keys" | "requests" | "logs";

type CredentialMode = "form" | "paste" | "oauth";

const CREDENTIAL_MODE_LABEL: Record<CredentialMode, string> = {
  form: "Form",
  paste: "Paste",
  oauth: "OAuth",
};

function credentialModes(provider: AdminPlugin | null): CredentialMode[] {
  const modes: CredentialMode[] = [];
  if (provider?.credentialsForm.length) modes.push("form");
  if (provider?.hasParseCredentials) modes.push("paste");
  if (provider?.hasOAuth) modes.push("oauth");
  return modes;
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
          setBootError(isApiError(error) ? error.message : "failed to load session");
        }
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return <p className="empty">Loading administration…</p>;
  }
  if (disabled) {
    return (
      <div className="login-screen">
      <main className="login">
        <h1>Administration disabled</h1>
        <p>Set <code>VIATE_ADMIN_PASSWORD</code> and restart the server to enable management.</p>
      </main>
      </div>
    );
  }
  if (bootError) {
    return (
      <div className="login-screen">
      <main className="login">
        <h1>Unable to load admin</h1>
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
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">V</span>
        <div>
          <div className="brand-name">Viate</div>
          <div className="brand-sub">Admin</div>
        </div>
      </div>
      <h1>Viate administrator</h1>
      <p className="meta">Sign in to manage plugins and provider connections.</p>
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
            setError(isApiError(err) ? err.message : "login failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Password
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
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
    </div>
  );
}

function Console({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>("plugins");
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [balanceConnectionId, setBalanceConnectionId] = useState<string | null>(null);
  const [editConnectionId, setEditConnectionId] = useState<string | null>(null);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">V</span>
          <div>
            <div className="brand-name">Viate</div>
            <div className="brand-sub">Gateway admin</div>
          </div>
        </div>
        <nav className="nav" aria-label="Administration">
          <NavButton page="plugins" current={page} onClick={setPage}>Plugins</NavButton>
          <NavButton page="connections" current={page} onClick={setPage}>Connections</NavButton>
          <NavButton page="balances" current={page} onClick={setPage}>Balances</NavButton>
          <NavButton page="models" current={page} onClick={setPage}>Models</NavButton>
          <NavButton page="prices" current={page} onClick={setPage}>Prices</NavButton>
          <NavButton page="channels" current={page} onClick={setPage}>Channels</NavButton>
          <NavButton page="users" current={page} onClick={setPage}>Users</NavButton>
          <NavButton page="api-keys" current={page} onClick={setPage}>API keys</NavButton>
          <NavButton page="requests" current={page} onClick={setPage}>Requests</NavButton>
          <NavButton page="logs" current={page} onClick={setPage}>Logs</NavButton>
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
            Log out
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <div className="page-heading">
            <h1>{pageLabel(page)}</h1>
            <p className="page-desc">{pageDescription(page)}</p>
          </div>
          <button
            className="logout-mobile ghost"
            type="button"
            onClick={async () => {
              await logout();
              onLogout();
            }}
          >
            Log out
          </button>
        </div>
        {notice ? <p className="banner ok" role="status">{notice}</p> : null}
        {page === "plugins" ? <PluginsPage onNotice={setNotice} /> : null}
        {page === "connections" ? (
          <ConnectionsPage
            onNotice={setNotice}
            onManageModels={(connectionId) => {
              setSelectedConnectionId(connectionId);
              setPage("models");
            }}
            onOpenBalance={(connectionId) => {
              setBalanceConnectionId(connectionId);
              setPage("balances");
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
              setPage("connections");
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
        {page === "api-keys" ? <ApiKeysPage onNotice={setNotice} /> : null}
        {page === "requests" ? <RequestsPage /> : null}
        {page === "logs" ? <LogsPage /> : null}
      </main>
      <nav className="mobile-nav" aria-label="Administration">
        <NavButton page="plugins" current={page} onClick={setPage}>Plugins</NavButton>
        <NavButton page="connections" current={page} onClick={setPage}>Connections</NavButton>
        <NavButton page="balances" current={page} onClick={setPage}>Balances</NavButton>
        <NavButton page="models" current={page} onClick={setPage}>Models</NavButton>
        <NavButton page="prices" current={page} onClick={setPage}>Prices</NavButton>
        <NavButton page="channels" current={page} onClick={setPage}>Channels</NavButton>
        <NavButton page="users" current={page} onClick={setPage}>Users</NavButton>
        <NavButton page="api-keys" current={page} onClick={setPage}>API keys</NavButton>
        <NavButton page="requests" current={page} onClick={setPage}>Requests</NavButton>
        <NavButton page="logs" current={page} onClick={setPage}>Logs</NavButton>
      </nav>
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
    <button type="button" aria-current={current === page ? "page" : undefined} onClick={() => onClick(page)}>
      {children}
    </button>
  );
}

function pageLabel(page: Page): string {
  if (page === "plugins") {
    return "Installed plugins";
  }
  if (page === "connections") {
    return "Connections";
  }
  if (page === "balances") {
    return "Balances";
  }
  if (page === "models") {
    return "Models";
  }
  if (page === "prices") {
    return "Model prices";
  }
  if (page === "channels") {
    return "Channels";
  }
  if (page === "users") {
    return "Users";
  }
  if (page === "api-keys") {
    return "Client API keys";
  }
  if (page === "requests") {
    return "Requests";
  }
  return "Operation logs";
}

function pageDescription(page: Page): string {
  if (page === "plugins") {
    return "Install trusted packages, then restart to load them. Protocol toggles only change /v1/models discovery.";
  }
  if (page === "connections") {
    return "Store encrypted provider credentials. Enable any number of connections.";
  }
  if (page === "balances") {
    return "Cached upstream subscription remaining. Refresh reads the provider.";
  }
  if (page === "models") {
    return "Sync inventory per connection. Same ids publish as one aggregated /v1/models entry.";
  }
  if (page === "prices") {
    return "Set a USD price per million tokens when models.dev has no row for that id.";
  }
  if (page === "channels") {
    return "Create a price multiplier and the models it covers. Assign channels to each customer.";
  }
  if (page === "users") {
    return "Provision customers and grant a dollar balance. Customers sign in at /portal.";
  }
  if (page === "api-keys") {
    return "Customers create keys at /portal. This page lists prefixes and revokes leaked keys.";
  }
  if (page === "requests") {
    return "Per-request cache, first token, TPS, and token usage. Statistics use the same filters. Detail is kept for 7 days.";
  }
  return "Install, update, and remove operations.";
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
    refresh().catch((err) => setError(isApiError(err) ? err.message : "failed to load plugins"));
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
      setError(isApiError(err) ? err.message : "update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      {pending ? <p className="banner warn">A plugin change is pending. Restart the server to load it.</p> : null}
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
            setError(isApiError(err) ? err.message : "install failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-header">
          <h2>Install plugin</h2>
          <p className="meta">Local path, tarball, git URL, or npm package. Leading dashes are rejected.</p>
        </div>
        <label>
          Plugin source
          <input
            name="source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="/data/plugins/official.tgz"
            required
          />
        </label>
        <button className="primary" type="submit" disabled={busy || !source.trim()}>
          {busy ? "Installing…" : "Install plugin"}
        </button>
      </form>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {plugins === null ? <p className="empty">Loading plugins…</p> : null}
      {plugins && plugins.length === 0 ? (
        <div className="empty">
          <strong>No plugins installed</strong>
          Add an official tarball path to get started.
        </div>
      ) : null}
      {plugins?.map((plugin) => (
        <article className="resource" key={plugin.name}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{plugin.name}</h2>
              <StatusBadge tone={plugin.error ? "error" : plugin.status === "active" ? "ok" : "warn"}>
                {plugin.status}
              </StatusBadge>
              {plugin.restartRequired ? <StatusBadge tone="warn">restart required</StatusBadge> : null}
            </div>
            <dl className="meta-list">
              <div><dt>Version</dt><dd>{plugin.version}</dd></div>
              <div><dt>Source</dt><dd>{plugin.source}</dd></div>
              {plugin.id ? <div><dt>Provider</dt><dd>{plugin.id}</dd></div> : null}
            </dl>
            {plugin.id ? (
              <div className="protocol-toggles">
                <p className="meta">Advertised on GET /v1/models. Requests are unchanged.</p>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={plugin.advertisedEndpointTypes.includes("openai")}
                    disabled={busy}
                    onChange={(event) => {
                      void updateAdvertisedEndpoints(plugin, "openai", event.target.checked);
                    }}
                  />
                  Chat Completions
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={plugin.advertisedEndpointTypes.includes("openai-response")}
                    disabled={busy}
                    onChange={(event) => {
                      void updateAdvertisedEndpoints(plugin, "openai-response", event.target.checked);
                    }}
                  />
                  Responses
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={plugin.advertisedEndpointTypes.includes("openai-image")}
                    disabled={busy}
                    onChange={(event) => {
                      void updateAdvertisedEndpoints(plugin, "openai-image", event.target.checked);
                    }}
                  />
                  Images
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={plugin.advertisedEndpointTypes.includes("openai-audio")}
                    disabled={busy}
                    onChange={(event) => {
                      void updateAdvertisedEndpoints(plugin, "openai-audio", event.target.checked);
                    }}
                  />
                  Audio
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={plugin.advertisedEndpointTypes.includes("openai-video")}
                    disabled={busy}
                    onChange={(event) => {
                      void updateAdvertisedEndpoints(plugin, "openai-video", event.target.checked);
                    }}
                  />
                  Video
                </label>
              </div>
            ) : null}
            {plugin.error ? <div className="status error">Load error: {plugin.error}</div> : null}
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
                  setError(isApiError(err) ? err.message : "update failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Update
            </button>
            <button className="danger" type="button" disabled={busy} onClick={() => setConfirm(plugin)}>
              Uninstall
            </button>
          </div>
        </article>
      ))}
      {confirm ? (
        <ConfirmDialog
          title={`Uninstall ${confirm.name}?`}
          body="Connection credentials are kept. The plugin is staged for removal until the server restarts."
          confirmLabel="Uninstall"
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
              setError(isApiError(err) ? err.message : "uninstall failed");
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
    refresh().catch((err) => setError(isApiError(err) ? err.message : "failed to load API keys"));
  }, []);

  return (
    <section className="stack">
      <article className="panel">
        <div className="panel-header">
          <h2>Client keys</h2>
          <p className="meta">Customers create keys at /portal. Revoke a leaked key here. Secrets are not shown again.</p>
        </div>
      </article>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {keys === null ? <p className="empty">Loading API keys…</p> : null}
      {keys && keys.length === 0 ? (
        <div className="empty">
          <strong>No client API keys</strong>
          Customers create keys at /portal.
        </div>
      ) : null}
      {keys?.map((key) => (
        <article className="resource" key={key.id}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{key.name}</h2>
              <StatusBadge>{key.prefix}…</StatusBadge>
            </div>
            <div className="meta">Created {new Date(key.createdAt).toLocaleString()}</div>
            {key.userId ? (
              <div className="meta">{users.find((user) => user.id === key.userId)?.email ?? key.userId}</div>
            ) : null}
          </div>
          <div className="row-actions">
            <button className="danger" type="button" onClick={() => setConfirm(key)}>
              Revoke
            </button>
          </div>
        </article>
      ))}
      {confirm ? (
        <ConfirmDialog
          title={`Revoke ${confirm.name}?`}
          body="Clients using this key will receive 401 immediately."
          confirmLabel="Revoke"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await api(`/api/admin/api-keys/${confirm.id}`, { method: "DELETE" });
              await refresh();
              onNotice("API key revoked.");
            } catch (err) {
              setError(isApiError(err) ? err.message : "revoke failed");
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
    refresh().catch((err) => setError(isApiError(err) ? err.message : "failed to load connections"));
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
          New connection
        </button>
      </div>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {connections === null ? <p className="empty">Loading connections…</p> : null}
      {connections && connections.length === 0 ? (
        <div className="empty">
          <strong>No stored connections</strong>
          Choose a loaded plugin to create one.
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
                {connection.active ? "active" : "inactive"}
              </StatusBadge>
              <StatusBadge tone={connection.hasCredentials ? "ok" : "warn"}>
                {connection.hasCredentials ? "credentials saved" : "needs credentials"}
              </StatusBadge>
              {orphan ? <StatusBadge tone="warn">orphan</StatusBadge> : null}
            </div>
            <dl className="meta-list">
              <div><dt>Provider</dt><dd>{connection.providerId}</dd></div>
            </dl>
            {connection.keepaliveStatus !== "idle" ? (
              <div className={`status ${connection.keepaliveStatus === "ok" ? "ok" : "warn"}`}>
                Keepalive {connection.keepaliveStatus}{connection.keepaliveError ? ` · ${connection.keepaliveError}` : ""}
              </div>
            ) : null}
            {subscription ? (
              <button className="ghost balance-link" type="button" onClick={() => onOpenBalance(connection.id)}>
                {balanceSummary(subscription)}
              </button>
            ) : null}
          </div>
          <div className="row-actions">
            <button type="button" disabled={orphan} onClick={() => setEditing(connection)}>Configure</button>
            <button
              type="button"
              disabled={orphan || !connection.hasCredentials}
              title={orphan ? "Reinstall the plugin before managing models" : !connection.hasCredentials ? "Save credentials before managing models" : undefined}
              onClick={() => onManageModels(connection.id)}
            >
              Models
            </button>
            <button
              type="button"
              disabled={orphan || !connection.hasCredentials}
              title={orphan ? "Reinstall the plugin before activation" : !connection.hasCredentials ? "Save credentials before activation" : undefined}
              onClick={async () => {
                try {
                  await api(`/api/admin/connections/${connection.id}/${connection.active ? "deactivate" : "activate"}`, { method: "POST" });
                  await refresh();
                  onNotice(`${connection.displayLabel || connection.providerId} is now ${connection.active ? "inactive" : "active"}.`);
                } catch (err) {
                  setError(isApiError(err) ? err.message : "activation failed");
                }
              }}
            >
              {connection.active ? "Deactivate" : "Activate"}
            </button>
            <button className="danger" type="button" onClick={() => setConfirm(connection)}>
              Delete
            </button>
          </div>
        </article>
        );
      })}
      {creating ? (
        <ProviderPicker
          plugins={plugins ?? []}
          onCancel={() => setCreating(false)}
          onCreated={async (connection) => {
            await refresh();
            setCreating(false);
            setEditing(connection);
          }}
        />
      ) : null}
      {editing ? (
        <ConnectionForm
          existing={editing}
          provider={plugins?.find((plugin) => plugin.id === editing.providerId) ?? null}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
            setEditing(null);
            onNotice("Connection saved.");
          }}
        />
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={`Delete ${confirm.displayLabel || confirm.providerId}?`}
          body="This removes the stored connection. Plugin credentials for other connections are kept."
          confirmLabel="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await api(`/api/admin/connections/${confirm.id}`, { method: "DELETE" });
              await refresh();
              onNotice("Connection deleted.");
            } catch (err) {
              setError(isApiError(err) ? err.message : "delete failed");
            } finally {
              setConfirm(null);
            }
          }}
        />
      ) : null}
    </section>
  );
}

function ProviderPicker({
  plugins,
  onCancel,
  onCreated,
}: {
  plugins: AdminPlugin[];
  onCancel: () => void;
  onCreated: (connection: Connection) => Promise<void>;
}) {
  const loaded = plugins.filter((plugin) => plugin.id && plugin.status === "active" && !plugin.error);
  const [providerId, setProviderId] = useState(loaded[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-picker-title"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const result = await api<{ connection: Connection }>("/api/admin/connections", {
              method: "POST",
              body: JSON.stringify({ providerId }),
            });
            await onCreated(result.connection);
          } catch (err) {
            setError(isApiError(err) ? err.message : "connection creation failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id="provider-picker-title">New connection</h2>
        <label>
          Loaded plugin
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)} required>
            {loaded.map((plugin) => <option key={plugin.id} value={plugin.id ?? ""}>{plugin.name}</option>)}
          </select>
        </label>
        {loaded.length === 0 ? <p className="banner warn">Install and restart a provider plugin first.</p> : null}
        {error ? <p className="banner error" role="alert">{error}</p> : null}
        <div className="row-actions">
          <button className="primary" type="submit" disabled={busy || !providerId}>{busy ? "Creating…" : "Continue"}</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function ConnectionForm({
  existing,
  provider,
  onCancel,
  onSaved,
}: {
  existing: Connection;
  provider: AdminPlugin | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [paste, setPaste] = useState("");
  const modes = credentialModes(provider);
  const [mode, setMode] = useState<CredentialMode>(modes[0] ?? "paste");
  const [oauth, setOAuth] = useState<OAuthStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-form-title"
        onSubmit={async (event) => {
          event.preventDefault();
          if (mode === "oauth") return;
          setBusy(true);
          setError(null);
          try {
            const payload = mode === "paste" ? { text: paste } : { credentials: values };
            await api(`/api/admin/connections/${existing.id}`, {
              method: "PUT",
              body: JSON.stringify(payload),
            });
            await onSaved();
          } catch (err) {
            setError(isApiError(err) ? err.message : "save failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id="connection-form-title">Configure {existing.displayLabel || existing.providerId}</h2>
        <p className="meta">Credentials are encrypted and never returned to this page.</p>
        {modes.length > 1 ? (
          <div className="segmented" role="tablist" aria-label="Credential method">
            {modes.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={mode === item}
                onClick={() => {
                  setMode(item);
                  if (item !== "oauth") {
                    setOAuth(null);
                    setError(null);
                  }
                }}
              >
                {CREDENTIAL_MODE_LABEL[item]}
              </button>
            ))}
          </div>
        ) : null}
        {mode === "form"
          ? provider?.credentialsForm.map((field: CredentialField) => (
              <label key={field.key}>
                {field.label}
                <input
                  type={field.kind === "secret" ? "password" : field.kind}
                  autoComplete={field.kind === "secret" ? "new-password" : undefined}
                  value={values[field.key] ?? ""}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                  required={field.required}
                />
              </label>
            ))
          : null}
        {mode === "paste" ? (
          <label>
            Credential JSON or token
            <textarea value={paste} onChange={(event) => setPaste(event.target.value)} required />
          </label>
        ) : null}
        {mode === "oauth" && busy && !oauth ? <p className="meta">Starting OAuth…</p> : null}
        {mode === "oauth" && oauth?.type === "device_code" ? (
          <DeviceCodePanel connectionId={existing.id} flow={oauth} onComplete={onSaved} onError={setError} />
        ) : null}
        {mode === "oauth" && oauth?.type === "authorization_url" ? (
          <AuthUrlPanel connectionId={existing.id} url={oauth.authorizationUrl} onComplete={onSaved} />
        ) : null}
        {error ? <p className="banner error" role="alert">{error}</p> : null}
        <div className="row-actions">
          {mode === "oauth" ? (
            oauth ? null : (
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const started = await api<OAuthStart>(`/api/admin/connections/${existing.id}/oauth/start`, {
                      method: "POST",
                    });
                    setOAuth(started);
                    if (started.type === "authorization_url") {
                      window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
                    }
                  } catch (err) {
                    setError(isApiError(err) ? err.message : "OAuth start failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Starting…" : "Connect"}
              </button>
            )
          ) : (
            <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          )}
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
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
        else onError(result.error ?? "OAuth failed");
      } catch (err) {
        if (cancelled || finished) return;
        window.clearInterval(timer);
        onError(isApiError(err) ? err.message : "OAuth polling failed");
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
      Open <a href={flow.verificationUrl} target="_blank" rel="noreferrer">{flow.verificationUrl}</a> and enter <code>{flow.userCode}</code>. Waiting for authorization…
    </div>
  );
}

function AuthUrlPanel({
  connectionId,
  url,
  onComplete,
}: {
  connectionId: string;
  url: string;
  onComplete: () => Promise<void>;
}) {
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
    <div className="banner ok" role="status">
      Opened authorization page in a new window. Complete sign-in there, or{" "}
      <a href={url} target="_blank" rel="noreferrer">
        click here
      </a>{" "}
      if it didn't open. Waiting for authorization…
    </div>
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
  const [saving, setSaving] = useState(false);

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
        setError(isApiError(err) ? err.message : "failed to load connections");
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
          setError(isApiError(err) ? err.message : "failed to load models");
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

  async function movePublishedProvider(model: AdminPublishedModel, index: number, delta: number): Promise<void> {
    const next = index + delta;
    if (next < 0 || next >= model.providers.length) {
      return;
    }
    const providerIds = model.providers.map((provider) => provider.providerId);
    const [moved] = providerIds.splice(index, 1);
    if (!moved) {
      return;
    }
    providerIds.splice(next, 0, moved);
    setError(null);
    try {
      const result = await api<{ models: AdminPublishedModel[] }>(
        `/api/admin/published-models/${encodeURIComponent(model.publicId)}/providers`,
        { method: "PUT", body: JSON.stringify({ providerIds }) },
      );
      setPublished(result.models);
    } catch (err) {
      setError(isApiError(err) ? err.message : "reorder failed");
    }
  }

  async function setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
    if (!selected) {
      return;
    }
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
      setError(isApiError(err) ? err.message : "update failed");
    }
  }

  async function refreshPublished(): Promise<void> {
    const publishedResult = await api<{ models: AdminPublishedModel[] }>("/api/admin/published-models");
    setPublished(publishedResult.models);
  }

  async function addCustomModel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected) {
      return;
    }
    const id = customId.trim();
    if (!id) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api<ConnectionModelCatalog>(`/api/admin/connections/${selected.id}/models`, {
        method: "POST",
        body: JSON.stringify({
          id,
          ...(customName.trim() ? { name: customName.trim() } : {}),
        }),
      });
      setCatalog(result);
      await refreshPublished();
      setCustomId("");
      setCustomName("");
      onNotice(`Added ${id}.`);
    } catch (err) {
      setError(isApiError(err) ? err.message : "add failed");
    } finally {
      setSaving(false);
    }
  }

  async function removeCustomModel(modelId: string): Promise<void> {
    if (!selected) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api<ConnectionModelCatalog>(
        `/api/admin/connections/${selected.id}/models/${encodeURIComponent(modelId)}`,
        { method: "DELETE" },
      );
      setCatalog(result);
      await refreshPublished();
      onNotice(`Removed ${modelId}.`);
    } catch (err) {
      setError(isApiError(err) ? err.message : "remove failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="stack">
      <div className="toolbar model-toolbar">
        <label className="connection-picker">
          Connection
          <select
            value={selectedConnectionId ?? ""}
            onChange={(event) => onSelectConnection(event.target.value)}
            disabled={!connections?.length}
          >
            {connections?.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.displayLabel || connection.providerId}
                {connection.active ? " (active)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          type="button"
          disabled={busy || !canSync}
          title={!selected ? "Create a connection first" : !selected.hasCredentials ? "Save credentials before syncing" : !selectedPlugin?.capabilities.includes("listModels") ? "This provider does not list models" : undefined}
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
              onNotice(`Synced ${result.models.length} model${result.models.length === 1 ? "" : "s"}.`);
            } catch (err) {
              setError(isApiError(err) ? err.message : "sync failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Syncing…" : "Sync models"}
        </button>
      </div>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {connections === null ? <p className="empty">Loading connections…</p> : null}
      {connections && connections.length === 0 ? (
        <div className="empty">
          <strong>No stored connections</strong>
          Create a connection before syncing models.
        </div>
      ) : null}
      {selected && !selected.hasCredentials ? (
        <p className="banner warn">Save credentials on this connection before syncing models.</p>
      ) : null}
      {selected && selected.hasCredentials && selectedPlugin && !selectedPlugin.capabilities.includes("listModels") ? (
        <p className="banner warn">This provider does not implement listModels.</p>
      ) : null}
      {connections && connections.length > 0 ? (
        <div className="models-workspace">
          <section className="models-pane" aria-labelledby="model-inventory-title">
            <div className="models-pane-head">
              <div className="models-pane-title">
                <h2 id="model-inventory-title">Inventory</h2>
                <p className="meta">
                  {!catalog
                    ? "Loading this connection."
                    : `${catalog.syncedAt ? `Last synced ${new Date(catalog.syncedAt).toLocaleString()}.` : "Not synced yet."} ${totals.enabled} enabled of ${totals.total}.${filtering ? ` Showing ${filtered.length}.` : ""}`}
                </p>
              </div>
              <div className="models-pane-tools">
                <label className="model-filter">
                  Filter
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="name or id"
                    type="search"
                  />
                </label>
               <div className="segmented" role="group" aria-label="Model status">
                 <button type="button" aria-pressed={visibility === "all"} onClick={() => setVisibility("all")}>
                   All {totals.total}
                 </button>
                 <button type="button" aria-pressed={visibility === "enabled"} onClick={() => setVisibility("enabled")}>
                   Enabled {totals.enabled}
                 </button>
                 <button type="button" aria-pressed={visibility === "disabled"} onClick={() => setVisibility("disabled")}>
                   Disabled {totals.disabled}
                 </button>
                </div>
              </div>
              <form className="custom-model-form" onSubmit={(event) => void addCustomModel(event)}>
                <label>
                  Model id
                  <input
                    value={customId}
                    onChange={(event) => setCustomId(event.target.value)}
                    placeholder="grok-voice-transcribe-2.0"
                    autoComplete="off"
                    disabled={!selected || !catalog || saving}
                    required
                  />
                </label>
                <label>
                  Name
                  <input
                    value={customName}
                    onChange={(event) => setCustomName(event.target.value)}
                    placeholder="optional"
                    autoComplete="off"
                    disabled={!selected || !catalog || saving}
                  />
                </label>
                <button className="primary" type="submit" disabled={!selected || !catalog || saving || !customId.trim()}>
                  {saving ? "Saving…" : "Add"}
                </button>
              </form>
            </div>
            <div className="model-scroll">
              {!catalog ? (
                <p className="empty">Loading models…</p>
              ) : catalog.models.length === 0 ? (
                <div className="empty">
                  <strong>No models yet</strong>
                  Sync this connection to fetch the provider catalog.
                </div>
              ) : filtered.length === 0 ? (
                <div className="empty">
                  <strong>No matching models</strong>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setVisibility("all");
                    }}
                  >
                    Clear filter
                  </button>
                </div>
              ) : (
                <table className="model-table">
                  <caption className="visually-hidden">
                    Models for {selected?.displayLabel || selected?.providerId || "this connection"}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
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
                                aria-label={`${model.enabled ? "Disable" : "Enable"} ${model.name}`}
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
                                <span className="badge">Custom</span>
                                <button
                                  className="danger"
                                  type="button"
                                  disabled={saving}
                                  onClick={() => void removeCustomModel(model.id)}
                                >
                                  Remove
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
                <h2 id="published-models-title">Published</h2>
                <p className="meta">
                  {published === null
                    ? "Loading public catalog."
                    : published.length === 0
                      ? "Nothing is on /v1/models yet."
                      : `${published.length} public id${published.length === 1 ? "" : "s"}.`}
                  {published?.some((model) => model.providers.length > 1)
                    ? " First provider is the default route."
                    : ""}
                </p>
              </div>
            </div>
            <div className="model-scroll">
              {published === null ? (
                <p className="empty">Loading published models…</p>
              ) : published.length === 0 ? (
                <div className="empty">
                  <strong>No published models</strong>
                  Enable models on an active connection.
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
                              disabled={index === 0}
                              onClick={() => void movePublishedProvider(model, index, -1)}
                            >
                              Up
                            </button>
                            <button
                              type="button"
                              disabled={index === model.providers.length - 1}
                              onClick={() => void movePublishedProvider(model, index, 1)}
                            >
                              Down
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
    </section>
  );
}

function LogsPage() {
  const [logs, setLogs] = useState<OperationLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ logs: OperationLog[] }>("/api/admin/logs")
      .then((result) => setLogs(result.logs))
      .catch((err) => setError(isApiError(err) ? err.message : "failed to load logs"));
  }, []);

  return (
    <section className="stack">
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {logs === null ? <p className="empty">Loading logs…</p> : null}
      {logs && logs.length === 0 ? (
        <div className="empty">
          <strong>No operations yet</strong>
          Install, update, or remove a plugin to see logs here.
        </div>
      ) : null}
      {logs && logs.length > 0 ? (
        <div className="log-list">
          {logs.map((log) => (
            <article className="log-row" key={log.id}>
              <time dateTime={log.createdAt}>{new Date(log.createdAt).toLocaleString()}</time>
              <div className="resource-main">
                <div className="resource-title-row">
                  <h2>{log.action}</h2>
                  <StatusBadge tone={log.status === "success" ? "ok" : "error"}>{log.status}</StatusBadge>
                  {log.restartRequired ? <StatusBadge tone="warn">restart required</StatusBadge> : null}
                </div>
                <dl className="meta-list">
                  {log.name ? <div><dt>Plugin</dt><dd>{log.name}</dd></div> : null}
                  {log.source ? <div><dt>Source</dt><dd>{log.source}</dd></div> : null}
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

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="row-actions">
          <button className="danger" type="button" onClick={() => void onConfirm()}>
            {confirmLabel}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
