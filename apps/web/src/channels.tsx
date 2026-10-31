import { useEffect, useState } from "react";
import { api, isApiError, type AdminPlugin, type AdminPublishedModel, type ChannelRule, type ChannelView } from "./api";
import { m } from "./paraglide/messages.js";

type CatalogModel = {
  id: string;
  providers: string[];
};

export function ChannelsPage({ onNotice }: { onNotice: (value: string | null) => void }) {
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ratio, setRatio] = useState("1");
  const [coverage, setCoverage] = useState<"all" | "models">("all");
  const [providerId, setProviderId] = useState("");
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [channelResult, publishedResult, pluginResult] = await Promise.all([
      api<{ channels: ChannelView[] }>("/api/admin/channels"),
      api<{ models: AdminPublishedModel[] }>("/api/admin/published-models"),
      api<{ plugins: AdminPlugin[] }>("/api/admin/plugins"),
    ]);
    const models = channelCatalog(publishedResult.models);
    setChannels(channelResult.channels);
    setCatalog(models);
    setProviders(providerChoices(pluginResult.plugins, models));
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : m.error_load_channels()));
  }, []);

  function load(channel: ChannelView) {
    setEditing(channel.id);
    setName(channel.name);
    setRatio(channel.ratio);
    setFilter("");
    setProviderId("");
    if (channel.rule.kind === "all") {
      setCoverage("all");
      setModelIds([]);
    } else {
      setCoverage("models");
      setModelIds(channel.rule.modelIds);
    }
    setError(null);
  }

  function reset() {
    setEditing(null);
    setName("");
    setRatio("1");
    setCoverage("all");
    setProviderId("");
    setModelIds([]);
    setFilter("");
  }

  const needle = filter.trim().toLowerCase();
  const visible = (catalog ?? []).filter((model) => {
    if (providerId && !model.providers.includes(providerId)) {
      return false;
    }
    return !needle || model.id.toLowerCase().includes(needle);
  });
  const missing = modelIds.filter((id) => !(catalog ?? []).some((model) => model.id === id));
  const rule: ChannelRule = coverage === "all" ? { kind: "all" } : { kind: "models", modelIds };

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
          <p className="meta">{m.channels_hint()}</p>
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
            value={coverage}
            onChange={(event) => setCoverage(event.target.value === "models" ? "models" : "all")}
          >
            <option value="all">{m.coverage_all()}</option>
            <option value="models">{m.coverage_selected()}</option>
          </select>
        </label>
        {coverage === "models" ? (
          <>
            <label>
              {m.label_provider()}
              <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                <option value="">{m.label_any_provider()}</option>
                {providers.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </label>
            <p className="meta">{m.channels_filter_keeps()}</p>
            <label>
              {m.label_filter()}
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={m.channels_filter_placeholder()} />
            </label>
            <div className="row-actions">
              <button
                className="ghost"
                type="button"
                onClick={() => setModelIds((current) => uniqueIds([...current, ...visible.map((model) => model.id)]))}
              >
                {m.action_select_shown()}
              </button>
              <button
                className="ghost"
                type="button"
                onClick={() => setModelIds((current) => current.filter((id) => !visible.some((model) => model.id === id)))}
              >
                {m.action_clear_shown()}
              </button>
            </div>
            <div className="model-checklist" role="group" aria-label={m.channels_published_models()}>
              {catalog === null ? <p className="meta">{m.channels_loading_models()}</p> : null}
              {catalog && visible.length === 0 && missing.length === 0 ? (
                <p className="meta">{m.channels_no_match()}</p>
              ) : null}
              {visible.map((model) => (
                <label className="toggle" key={model.id}>
                  <input
                    type="checkbox"
                    checked={modelIds.includes(model.id)}
                    onChange={(event) =>
                      setModelIds((current) =>
                        event.target.checked ? uniqueIds([...current, model.id]) : current.filter((id) => id !== model.id),
                      )
                    }
                  />
                  <span>
                    {model.id}
                    <span className="meta"> {model.providers.join(", ")}</span>
                  </span>
                </label>
              ))}
              {missing.map((id) => (
                <label className="toggle" key={id}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => setModelIds((current) => current.filter((item) => item !== id))}
                  />
                  <span>
                    {id}
                    <span className="meta"> {m.channels_not_published()}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : null}
        <div className="row-actions">
          <button className="primary" type="submit" disabled={busy || !name.trim() || (coverage === "models" && modelIds.length === 0)}>
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

function channelCatalog(models: AdminPublishedModel[]): CatalogModel[] {
  return models
    .map((model) => ({
      id: model.publicId,
      providers: model.providers.map((provider) => provider.providerId),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function providerChoices(plugins: AdminPlugin[], models: CatalogModel[]): string[] {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.id) {
      ids.add(plugin.id);
    }
  }
  for (const model of models) {
    for (const providerId of model.providers) {
      ids.add(providerId);
    }
  }
  return [...ids].sort();
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function describeRule(rule: ChannelRule): string {
  if (rule.kind === "all") {
    return m.channels_rule_all();
  }
  return rule.modelIds.length <= 4 ? rule.modelIds.join(", ") : m.count_rule_models({ count: rule.modelIds.length });
}
