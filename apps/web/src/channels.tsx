import { useEffect, useState } from "react";
import { api, isApiError, type ChannelRule, type ChannelView } from "./api";
import { m } from "./paraglide/messages.js";

const EMPTY_MATCH: ChannelRule = {
  kind: "match",
  providerId: null,
  prefix: null,
  excludePrefix: null,
  chatOnly: false,
};

export function ChannelsPage({ onNotice }: { onNotice: (value: string | null) => void }) {
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ratio, setRatio] = useState("1");
  const [rule, setRule] = useState<ChannelRule>({ kind: "all" });
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const result = await api<{ channels: ChannelView[] }>("/api/admin/channels");
    setChannels(result.channels);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : m.error_load_channels()));
  }, []);

  function load(channel: ChannelView) {
    setEditing(channel.id);
    setName(channel.name);
    setRatio(channel.ratio);
    setRule(channel.rule);
    setError(null);
  }

  function reset() {
    setEditing(null);
    setName("");
    setRatio("1");
    setRule({ kind: "all" });
  }

  return (
    <section className="stack">
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      <form
        className="panel form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          onNotice(null);
          try {
            const body = JSON.stringify({ name, ratio, rule });
            if (editing) {
              await api(`/api/admin/channels/${editing}`, { method: "PUT", body });
              onNotice(m.channels_saved());
            } else {
              await api("/api/admin/channels", { method: "POST", body });
              onNotice(m.channels_created());
            }
            reset();
            await refresh();
          } catch (err) {
            setError(isApiError(err) ? err.message : m.error_save());
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-header">
          <h2>{editing ? m.channels_edit() : m.channels_create()}</h2>
          <p className="meta">{m.channels_intro()}</p>
        </div>
        <label>
          {m.label_name()}
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          {m.label_ratio()}
          <input value={ratio} onChange={(event) => setRatio(event.target.value)} required />
        </label>
        <label>
          {m.label_models()}
          <select
            value={rule.kind}
            onChange={(event) => setRule(event.target.value === "match" ? { ...EMPTY_MATCH } : { kind: "all" })}
          >
            <option value="all">{m.coverage_all()}</option>
            <option value="match">{m.channels_match()}</option>
          </select>
        </label>
        {rule.kind === "match" ? (
          <>
            <label>
              {m.channels_provider_id()}
              <input
                value={rule.providerId ?? ""}
                onChange={(event) => setRule({ ...rule, providerId: event.target.value || null })}
              />
            </label>
            <label>
              {m.channels_model_prefix()}
              <input
                value={rule.prefix ?? ""}
                onChange={(event) => setRule({ ...rule, prefix: event.target.value || null })}
              />
            </label>
            <label>
              {m.channels_exclude_prefix()}
              <input
                value={rule.excludePrefix ?? ""}
                onChange={(event) => setRule({ ...rule, excludePrefix: event.target.value || null })}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={rule.chatOnly}
                onChange={(event) => setRule({ ...rule, chatOnly: event.target.checked })}
              />
              {m.channels_chat_only()}
            </label>
          </>
        ) : null}
        <div className="row-actions">
          <button className="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? m.busy_saving() : editing ? m.action_save_channel() : m.action_create_channel()}
          </button>
          {editing ? (
            <button className="ghost" type="button" disabled={busy} onClick={reset}>
              {m.action_cancel()}
            </button>
          ) : null}
        </div>
      </form>
      {channels === null ? <p className="meta">{m.channels_loading()}</p> : null}
      {channels && channels.length === 0 ? <p className="meta">{m.channels_empty()}</p> : null}
      {channels?.map((channel) => (
        <article className="resource" key={channel.id}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{channel.name}</h2>
              <span className="badge">{channel.ratio}x</span>
            </div>
            <div className="meta">{describeRule(channel.rule)}</div>
          </div>
          <div className="row-actions">
            <button type="button" onClick={() => load(channel)}>
              {m.action_edit()}
            </button>
            <button
              className="danger"
              type="button"
              onClick={() => {
                void (async () => {
                  setError(null);
                  onNotice(null);
                  try {
                    await api(`/api/admin/channels/${channel.id}`, { method: "DELETE" });
                    if (editing === channel.id) reset();
                    await refresh();
                    onNotice(m.channels_deleted());
                  } catch (err) {
                    setError(isApiError(err) ? err.message : m.error_delete());
                  }
                })();
              }}
            >
              {m.action_delete()}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function describeRule(rule: ChannelRule): string {
  if (rule.kind === "all") {
    return m.channels_rule_all();
  }
  const parts = [
    rule.providerId ? m.channels_rule_provider({ id: rule.providerId }) : "",
    rule.prefix ? m.channels_rule_prefix({ prefix: rule.prefix }) : "",
    rule.excludePrefix ? m.channels_rule_exclude({ prefix: rule.excludePrefix }) : "",
    rule.chatOnly ? m.channels_rule_chat() : "",
  ].filter((part) => part !== "");
  return parts.length > 0 ? parts.join(", ") : m.channels_rule_match();
}
