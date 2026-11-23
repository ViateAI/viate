import { useEffect, useState } from "react";
import { api, isApiError } from "./api";
import { ConfirmDialog } from "./dialog";
import { m } from "./paraglide/messages.js";

const SERVICE_SCOPES = ["users:read", "channels:read", "keys:write", "usage:read"] as const;

type OAuthClientView = {
  id: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  firstParty: boolean;
  allowHttpRedirects: boolean;
  createdAt: string;
};

type SecretNotice = { name: string; secret: string };

export function OAuthClientsPage({ onNotice }: { onNotice: (value: string | null) => void }) {
  const [clients, setClients] = useState<OAuthClientView[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [redirects, setRedirects] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [allowHttp, setAllowHttp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<SecretNotice | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "rotate" | "delete"; client: OAuthClientView } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  async function refresh() {
    const result = await api<{ clients: OAuthClientView[] }>("/api/admin/oauth-clients");
    setClients(result.clients);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : m.error_load_oauth_clients()));
  }, []);

  function resetForm() {
    setEditing(null);
    setName("");
    setRedirects("");
    setScopes([]);
    setAllowHttp(false);
  }

  function loadClient(client: OAuthClientView) {
    setEditing(client.id);
    setName(client.name);
    setRedirects(client.redirectUris.join("\n"));
    setScopes(client.scopes);
    setAllowHttp(client.allowHttpRedirects);
    setError(null);
    setSecret(null);
  }

  return (
    <section className="stack">
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {secret ? (
        <div className="banner ok secret-row">
          <div>
            <strong>{secret.name}</strong>
            <p><code>{secret.secret}</code></p>
            <p className="meta">{m.oauth_secret_once({ name: secret.name })}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(secret.secret);
            }}
          >
            {m.action_copy()}
          </button>
        </div>
      ) : null}
      <form
        className="panel form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          const payload = {
            name,
            redirectUris: redirects.split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
            scopes,
            allowHttpRedirects: allowHttp,
          };
          try {
            if (editing) {
              await api(`/api/admin/oauth-clients/${editing}`, { method: "PATCH", body: JSON.stringify(payload) });
              onNotice(m.oauth_saved());
            } else {
              const created = await api<{ client: OAuthClientView; secret: string }>("/api/admin/oauth-clients", {
                method: "POST",
                body: JSON.stringify(payload),
              });
              setSecret({ name: created.client.name, secret: created.secret });
              onNotice(m.oauth_created());
            }
            resetForm();
            await refresh();
          } catch (err) {
            setError(isApiError(err) ? err.message : m.error_save());
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>{editing ? m.oauth_clients_edit() : m.oauth_clients_create()}</h2>
        <label>
          {m.label_name()}
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          {m.oauth_field_redirects()}
          <textarea value={redirects} onChange={(event) => setRedirects(event.target.value)} spellCheck={false} />
        </label>
        <p className="meta">{m.oauth_field_redirects_hint()}</p>
        <div className="protocol-toggles">
          {SERVICE_SCOPES.map((scope) => (
            <label className="toggle" key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked ? [...current, scope] : current.filter((item) => item !== scope),
                  )
                }
              />
              <span>{scope}</span>
            </label>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={allowHttp} onChange={(event) => setAllowHttp(event.target.checked)} />
          <span>{m.oauth_allow_http()}</span>
        </label>
        {allowHttp ? <p className="banner warn">{m.oauth_allow_http_warning()}</p> : null}
        <div className="row-actions">
          <button className="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? m.busy_saving() : editing ? m.action_save() : m.oauth_action_create()}
          </button>
          {editing ? (
            <button className="ghost" type="button" onClick={resetForm}>
              {m.action_cancel()}
            </button>
          ) : null}
        </div>
      </form>
      {clients === null ? <p className="meta">{m.oauth_clients_loading()}</p> : null}
      {clients && clients.length === 0 ? <p className="meta">{m.oauth_clients_empty()}</p> : null}
      {clients?.map((client) => (
        <article className="resource" key={client.id}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{client.name}</h2>
              {client.allowHttpRedirects ? <span className="badge warn">HTTP</span> : null}
            </div>
            <p className="meta">{m.oauth_client_id()}: <code>{client.id}</code></p>
            <p className="meta">{client.redirectUris.join(", ") || "—"}</p>
            <p className="meta">{client.scopes.join(" ") || "—"}</p>
          </div>
          <div className="row-actions">
            <button type="button" onClick={() => loadClient(client)}>{m.action_edit()}</button>
            <button type="button" onClick={() => setConfirm({ kind: "rotate", client })}>{m.oauth_action_rotate()}</button>
            <button className="danger" type="button" onClick={() => setConfirm({ kind: "delete", client })}>{m.action_delete()}</button>
          </div>
        </article>
      ))}
      {confirm ? (
        <ConfirmDialog
          title={confirm.kind === "rotate" ? m.oauth_rotate_title({ name: confirm.client.name }) : m.oauth_delete_title({ name: confirm.client.name })}
          body={confirm.kind === "rotate" ? m.oauth_rotate_body() : m.oauth_delete_body()}
          confirmLabel={confirm.kind === "rotate" ? m.oauth_action_rotate() : m.action_delete()}
          busy={confirmBusy}
          onCancel={() => {
            if (!confirmBusy) setConfirm(null);
          }}
          onConfirm={async () => {
            setConfirmBusy(true);
            setError(null);
            try {
              if (confirm.kind === "rotate") {
                const rotated = await api<{ client: OAuthClientView; secret: string }>(
                  `/api/admin/oauth-clients/${confirm.client.id}/rotate-secret`,
                  { method: "POST" },
                );
                setSecret({ name: rotated.client.name, secret: rotated.secret });
                onNotice(m.oauth_rotated());
              } else {
                await api(`/api/admin/oauth-clients/${confirm.client.id}`, { method: "DELETE" });
                if (editing === confirm.client.id) resetForm();
                onNotice(m.oauth_deleted());
              }
              await refresh();
            } catch (err) {
              setError(isApiError(err) ? err.message : m.error_save());
            } finally {
              setConfirmBusy(false);
              setConfirm(null);
            }
          }}
        />
      ) : null}
    </section>
  );
}
