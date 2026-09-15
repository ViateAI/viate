import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  type OAuthStart,
  type OperationLog,
} from "./api";

type Page = "plugins" | "connections" | "models" | "api-keys" | "logs";

export function App() {
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
          <NavButton page="models" current={page} onClick={setPage}>Models</NavButton>
          <NavButton page="api-keys" current={page} onClick={setPage}>API keys</NavButton>
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
          />
        ) : null}
        {page === "models" ? (
          <ModelsPage
            onNotice={setNotice}
            selectedConnectionId={selectedConnectionId}
            onSelectConnection={setSelectedConnectionId}
          />
        ) : null}
        {page === "api-keys" ? <ApiKeysPage onNotice={setNotice} /> : null}
        {page === "logs" ? <LogsPage /> : null}
      </main>
      <nav className="mobile-nav" aria-label="Administration">
        <NavButton page="plugins" current={page} onClick={setPage}>Plugins</NavButton>
        <NavButton page="connections" current={page} onClick={setPage}>Connections</NavButton>
        <NavButton page="models" current={page} onClick={setPage}>Models</NavButton>
        <NavButton page="api-keys" current={page} onClick={setPage}>API keys</NavButton>
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
  if (page === "models") {
    return "Models";
  }
  if (page === "api-keys") {
    return "Client API keys";
  }
  return "Operation logs";
}

function pageDescription(page: Page): string {
  if (page === "plugins") {
    return "Install trusted packages, then restart to load them.";
  }
  if (page === "connections") {
    return "Store encrypted provider credentials. Enable any number of connections.";
  }
  if (page === "models") {
    return "Sync inventory per connection. Same ids publish as one aggregated /v1/models entry.";
  }
  if (page === "api-keys") {
    return "Issue hashed client keys for /v1. Secrets are shown once.";
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
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null);
  const [confirm, setConfirm] = useState<ClientApiKey | null>(null);

  async function refresh() {
    const result = await api<{ apiKeys: ClientApiKey[] }>("/api/admin/api-keys");
    setKeys(result.apiKeys);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : "failed to load API keys"));
  }, []);

  return (
    <section className="stack">
      <form
        className="panel form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          onNotice(null);
          try {
            const result = await api<{ apiKey: ClientApiKey; secret: string }>("/api/admin/api-keys", {
              method: "POST",
              body: JSON.stringify({ name }),
            });
            setName("");
            setRevealed({ name: result.apiKey.name, secret: result.secret });
            await refresh();
            onNotice("Copy this key now. It will not be shown again.");
          } catch (err) {
            setError(isApiError(err) ? err.message : "create failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-header">
          <h2>Create API key</h2>
          <p className="meta">Clients send <code>Authorization: Bearer</code> or <code>x-api-key</code>. The secret is shown once.</p>
        </div>
        <label>
          Key name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="codex"
            required
          />
        </label>
        <button className="primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create API key"}
        </button>
      </form>
      {revealed ? (
        <div className="banner ok secret-row" role="status">
          <div>
            Copy {revealed.name} now: <code>{revealed.secret}</code>
          </div>
        </div>
      ) : null}
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {keys === null ? <p className="empty">Loading API keys…</p> : null}
      {keys && keys.length === 0 ? (
        <div className="empty">
          <strong>No client API keys</strong>
          Create one before calling /v1/chat/completions.
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
}: {
  onNotice: (value: string | null) => void;
  onManageModels: (connectionId: string) => void;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [plugins, setPlugins] = useState<AdminPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<Connection | null>(null);

  async function refresh() {
    const [connectionResult, pluginResult] = await Promise.all([
      api<{ connections: Connection[] }>("/api/admin/connections"),
      api<{ plugins: AdminPlugin[] }>("/api/admin/plugins"),
    ]);
    setConnections(connectionResult.connections);
    setPlugins(pluginResult.plugins);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : "failed to load connections"));
  }, []);

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
  const [mode, setMode] = useState<"form" | "paste">(
    provider?.credentialsForm.length ? "form" : "paste",
  );
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
        {provider?.credentialsForm.length && provider.hasParseCredentials ? (
          <div className="segmented" role="tablist" aria-label="Credential method">
            <button type="button" aria-pressed={mode === "form"} onClick={() => setMode("form")}>Form</button>
            <button type="button" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>Paste</button>
          </div>
        ) : null}
        {mode === "form" ? provider?.credentialsForm.map((field: CredentialField) => (
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
        )) : (
          <label>
            Credential JSON or token
            <textarea value={paste} onChange={(event) => setPaste(event.target.value)} required />
          </label>
        )}
        {provider?.hasOAuth ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const started = await api<OAuthStart>(`/api/admin/connections/${existing.id}/oauth/start`, { method: "POST" });
                setOAuth(started);
                if (started.type === "authorization_url") {
                  window.location.assign(started.authorizationUrl);
                }
              } catch (err) {
                setError(isApiError(err) ? err.message : "OAuth start failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Connect with OAuth
          </button>
        ) : null}
        {oauth?.type === "device_code" ? (
          <DeviceCodePanel connectionId={existing.id} flow={oauth} onComplete={onSaved} onError={setError} />
        ) : null}
        {error ? <p className="banner error" role="alert">{error}</p> : null}
        <div className="row-actions">
          <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
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
  const [published, setPublished] = useState<AdminPublishedModel[] | null>(null);

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
    if (!needle) {
      return models;
    }
    return models.filter((model) =>
      model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
    );
  }, [catalog, query]);

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
      {selected && catalog ? (
        <>
          <label>
            Filter models
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="gpt-4o"
              type="search"
            />
          </label>
          <p className="meta">
            {catalog.syncedAt ? `Last synced ${new Date(catalog.syncedAt).toLocaleString()}. ` : "Not synced yet. "}
            {catalog.models.filter((model) => model.enabled).length} enabled of {catalog.models.length}.
          </p>
          {catalog.models.length === 0 ? (
            <div className="empty">
              <strong>No models yet</strong>
              Sync this connection to fetch the provider catalog.
            </div>
          ) : null}
          {catalog.models.length > 0 && filtered.length === 0 ? (
            <div className="empty">
              <strong>No matching models</strong>
              Try a different filter.
            </div>
          ) : null}
          {filtered.length > 0 ? (
            <div className="model-list" role="list">
              {filtered.map((model) => (
                <article className="resource model-row" key={model.id} role="listitem">
                  <div className="resource-main">
                    <div className="resource-title-row">
                      <h2>{model.name}</h2>
                      <StatusBadge tone={model.enabled ? "ok" : "neutral"}>
                        {model.enabled ? "enabled" : "disabled"}
                      </StatusBadge>
                    </div>
                    {model.name !== model.id ? <div className="meta"><code>{model.id}</code></div> : null}
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={model.enabled}
                      onChange={async (event) => {
                        const enabled = event.target.checked;
                        setError(null);
                        try {
                          const result = await api<ConnectionModelCatalog>(
                            `/api/admin/connections/${selected.id}/models/${encodeURIComponent(model.id)}`,
                            {
                              method: "PUT",
                              body: JSON.stringify({ enabled }),
                            },
                          );
                          setCatalog(result);
                          const publishedResult = await api<{ models: AdminPublishedModel[] }>("/api/admin/published-models");
                          setPublished(publishedResult.models);
                        } catch (err) {
                          setError(isApiError(err) ? err.message : "update failed");
                        }
                      }}
                    />
                    {model.enabled ? "Enabled" : "Disabled"}
                  </label>
                </article>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {published === null ? null : published.length === 0 ? (
        <div className="empty">
          <strong>No published models</strong>
          Enable a connection and sync models.
        </div>
      ) : (
        <div className="published-list">
          <h2 className="section-title">Published</h2>
          {published.map((model) => (
            <article className="resource" key={model.publicId}>
              <div className="resource-main">
                <div className="resource-title-row">
                  <h2>{model.publicId}</h2>
                  <StatusBadge tone="ok">{model.ownedBy}</StatusBadge>
                </div>
                {model.providers.length > 1 ? (
                  <p className="meta">
                    Pin <code>{model.providers[0] ? `${model.providers[0].providerId}/${model.publicId}` : ""}</code> to force a provider.
                  </p>
                ) : null}
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
              ) : (
                <p className="meta">{model.providers[0] ? model.providers[0].providerId : ""}</p>
              )}
            </article>
          ))}
        </div>
      )}
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
