import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { formatCount, formatDateTime, formatRate } from "./format";
import { m } from "./paraglide/messages.js";
import { api, isApiError, type ClientApiKey, type Connection } from "./api";

type Tab = "requests" | "statistics";

type Filters = {
  fromLocal: string;
  toLocal: string;
  model: string | null;
  connectionId: string | null;
  keyId: string;
  outcome: string;
  endpoint: string;
};

type RequestRow = {
  id: string;
  startedAt: string;
  durationMs: number;
  ttfbMs: number | null;
  endpoint: string;
  stream: boolean;
  status: number;
  outcome: string;
  requestModel: string | null;
  upstreamModel: string | null;
  providerId: string | null;
  connectionId: string | null;
  apiKeyPrefix: string | null;
  attemptCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  usageSource: "parser" | "missing" | string;
  error: string | null;
  payloadTruncated: boolean;
};

type Attempt = {
  seq: number;
  providerId: string;
  connectionId: string;
  upstreamModel: string | null;
  status: number | null;
  durationMs: number;
  error: string | null;
};

type ListResponse = {
  requests: RequestRow[];
  nextBefore?: string;
};

type RangeStats = {
  from: string;
  to: string;
  requests: number;
  errors: number;
  aborted: number;
  errorRate: number;
  rpm: number;
  tpm: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTpm: number;
  outputTpm: number;
  cacheReadTpm: number;
  cacheWriteTpm: number;
  avgDurationMs: number | null;
  avgTtfbMs: number | null;
  outputTps: number | null;
  series: Array<{
    t: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
  byModel: Array<{
    model: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
  byConnection: Array<{
    connectionId: string;
    providerId: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
};

type DetailState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; request: RequestRow; attempts: Attempt[]; payload: { request: unknown; response: unknown } | null };

const OUTCOMES = ["success", "upstream_error", "client_error", "aborted", "timeout", "auth_error"] as const;
const ENDPOINTS = [
  "chat.completions",
  "embeddings",
  "responses",
  "responses.compact",
  "images.generations",
  "images.edits",
  "audio.transcriptions",
  "audio.speech",
  "videos.generations",
  "videos.edits",
  "videos.extensions",
  "videos.result",
] as const;

export function RequestsPage() {
  const [defaults, setDefaults] = useState(defaultFilters);
  const [draft, setDraft] = useState(defaults);
  const [applied, setApplied] = useState(defaults);
  const [tab, setTab] = useState<Tab>("requests");
  const [formError, setFormError] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [keys, setKeys] = useState<ClientApiKey[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [statsRetry, setStatsRetry] = useState(0);
  const [list, setList] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; rows: RequestRow[]; nextBefore: string | null }>({
    status: "loading",
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; stats: RangeStats }>({
    status: "idle",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ connections: Connection[] }>("/api/admin/connections"),
      api<{ apiKeys: ClientApiKey[] }>("/api/admin/api-keys"),
    ])
      .then(([connectionResult, keyResult]) => {
        if (cancelled) return;
        setConnections(connectionResult.connections);
        setKeys(keyResult.apiKeys);
      })
      .catch((error) => {
        if (!cancelled) setCatalogError(messageOf(error, m.error_load_filters()));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setList({ status: "loading" });
    setMoreError(null);
    api<ListResponse>(`/api/admin/requests?${search(applied)}`)
      .then((result) => {
        if (!cancelled) {
          setList({ status: "ready", rows: result.requests, nextBefore: result.nextBefore ?? null });
        }
      })
      .catch((error) => {
        if (!cancelled) setList({ status: "error", message: messageOf(error, m.error_load_requests()) });
      });
    return () => {
      cancelled = true;
    };
  }, [applied, listRetry]);

  useEffect(() => {
    if (tab !== "statistics") return;
    let cancelled = false;
    setStats({ status: "loading" });
    api<{ stats: RangeStats }>(`/api/admin/requests/stats?${search(applied)}`)
      .then((result) => {
        if (!cancelled) setStats({ status: "ready", stats: result.stats });
      })
      .catch((error) => {
        if (!cancelled) setStats({ status: "error", message: messageOf(error, m.error_load_statistics()) });
      });
    return () => {
      cancelled = true;
    };
  }, [applied, tab, statsRetry]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setDetail({ status: "loading" });
    api<{ request: RequestRow; attempts: Attempt[]; payload: { request: unknown; response: unknown } | null }>(
      `/api/admin/requests/${encodeURIComponent(selectedId)}`,
    )
      .then((result) => {
        if (!cancelled) setDetail({ status: "ready", ...result });
      })
      .catch((error) => {
        if (cancelled) return;
        if (isApiError(error) && error.status === 404) {
          setDetail({ status: "missing" });
          return;
        }
        setDetail({ status: "error", message: messageOf(error, m.error_load_request()) });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  function applyDraft(event?: FormEvent) {
    event?.preventDefault();
    const from = new Date(draft.fromLocal).getTime();
    const to = new Date(draft.toLocal).getTime();
    if (Number.isNaN(from) || Number.isNaN(to)) {
      setFormError(m.requests_invalid_range());
      return;
    }
    if (from > to) {
      setFormError(m.requests_from_after());
      return;
    }
    setFormError(null);
    setApplied({
      ...draft,
      model: draft.model === null ? null : draft.model === "" ? "" : draft.model.trim() || null,
    });
  }

  function clearAll() {
    const next = defaultFilters();
    setDefaults(next);
    setDraft(next);
    setApplied(next);
    setFormError(null);
  }

  function applyFacet(patch: Partial<Filters>) {
    const next = { ...applied, ...patch };
    setDraft(next);
    setApplied(next);
    setTab("requests");
    setFormError(null);
  }

  async function loadOlder() {
    if (list.status !== "ready" || !list.nextBefore || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const result = await api<ListResponse>(`/api/admin/requests?${search(applied, list.nextBefore)}`);
      setList((current) => {
        if (current.status !== "ready") return current;
        const seen = new Set(current.rows.map((row) => row.id));
        return {
          status: "ready",
          rows: [...current.rows, ...result.requests.filter((row) => !seen.has(row.id))],
          nextBefore: result.nextBefore ?? null,
        };
      });
    } catch (error) {
      setMoreError(messageOf(error, m.error_load_older()));
    } finally {
      setLoadingMore(false);
    }
  }

  const showClear = !sameFilters(draft, defaults) || !sameFilters(applied, defaults);
  const extraFilters = applied.model !== null || applied.connectionId !== null || applied.keyId !== "" || applied.outcome !== "" || applied.endpoint !== "";

  return (
    <section className="stack">
      <div className="segmented" role="tablist" aria-label={m.requests_views()}>
        <button type="button" role="tab" aria-selected={tab === "requests"} aria-pressed={tab === "requests"} onClick={() => setTab("requests")}>
          {m.requests_tab_requests()}
        </button>
        <button type="button" role="tab" aria-selected={tab === "statistics"} aria-pressed={tab === "statistics"} onClick={() => setTab("statistics")}>
          {m.requests_tab_stats()}
        </button>
      </div>
      <form className="panel req-filters" onSubmit={applyDraft}>
        <div className="req-filter-grid">
          <label>
            {m.label_from()}
            <input type="datetime-local" value={draft.fromLocal} onChange={(event) => setDraft({ ...draft, fromLocal: event.target.value })} required />
          </label>
          <label>
            {m.label_to()}
            <input type="datetime-local" value={draft.toLocal} onChange={(event) => setDraft({ ...draft, toLocal: event.target.value })} required />
          </label>
          <label>
            {m.label_model()}
            <input
              value={draft.model ?? ""}
              placeholder={m.requests_model_placeholder()}
              onChange={(event) => setDraft({ ...draft, model: event.target.value === "" ? null : event.target.value })}
            />
          </label>
          <label>
            {m.label_connection()}
            <select
              value={draft.connectionId === null ? "" : draft.connectionId === "" ? "__none__" : draft.connectionId}
              onChange={(event) => {
                const value = event.target.value;
                setDraft({ ...draft, connectionId: value === "" ? null : value === "__none__" ? "" : value });
              }}
            >
              <option value="">{m.label_any()}</option>
              {draft.connectionId === "" ? <option value="__none__">{m.requests_any_connection()}</option> : null}
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connectionOption(connection)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.label_api_key()}
            <select value={draft.keyId} onChange={(event) => setDraft({ ...draft, keyId: event.target.value })}>
              <option value="">{m.label_any()}</option>
              {keys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.name} ({key.prefix})
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.label_outcome()}
            <select value={draft.outcome} onChange={(event) => setDraft({ ...draft, outcome: event.target.value })}>
              <option value="">{m.label_any()}</option>
              {OUTCOMES.map((outcome) => (
                <option key={outcome} value={outcome}>{outcomeLabel(outcome)}</option>
              ))}
            </select>
          </label>
          <label>
            {m.label_endpoint()}
            <select value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}>
              <option value="">{m.label_any()}</option>
              {ENDPOINTS.map((endpoint) => (
                <option key={endpoint} value={endpoint}>{endpoint}</option>
              ))}
            </select>
          </label>
        </div>
        {formError ? <p className="banner error" role="alert">{formError}</p> : null}
        {catalogError ? <p className="banner warn" role="status">{catalogError}</p> : null}
        <div className="row-actions">
          <button className="primary" type="submit">{m.action_apply()}</button>
          {showClear ? <button type="button" onClick={clearAll}>{m.action_clear_all()}</button> : null}
        </div>
      </form>
      <FilterChips
        applied={applied}
        defaults={defaults}
        connections={connections}
        keys={keys}
        onRemove={(patch) => {
          const next = { ...applied, ...patch };
          setDraft(next);
          setApplied(next);
        }}
      />
      {tab === "requests" ? (
        <RequestList
          list={list}
          extraFilters={extraFilters}
          connections={connections}
          selectedId={selectedId}
          loadingMore={loadingMore}
          moreError={moreError}
          onOpen={setSelectedId}
          onRetry={() => setListRetry((value) => value + 1)}
          onOlder={() => void loadOlder()}
        />
      ) : (
        <StatisticsView
          stats={stats}
          connections={connections}
          onRetry={() => setStatsRetry((value) => value + 1)}
          onModel={(model) => applyFacet({ model })}
          onConnection={(connectionId) => applyFacet({ connectionId })}
        />
      )}
      {selectedId ? (
        <RequestDetail
          id={selectedId}
          detail={detail}
          connections={connections}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </section>
  );
}

function FilterChips({
  applied,
  defaults,
  connections,
  keys,
  onRemove,
}: {
  applied: Filters;
  defaults: Filters;
  connections: Connection[];
  keys: ClientApiKey[];
  onRemove: (patch: Partial<Filters>) => void;
}) {
  const chips: Array<{ key: string; label: string; patch: Partial<Filters> }> = [];
  if (applied.fromLocal !== defaults.fromLocal || applied.toLocal !== defaults.toLocal) {
    chips.push({ key: "time", label: `${applied.fromLocal.replace("T", " ")} – ${applied.toLocal.replace("T", " ")}`, patch: { fromLocal: defaults.fromLocal, toLocal: defaults.toLocal } });
  }
  if (applied.model !== null) {
    chips.push({ key: "model", label: m.requests_chip_model({ name: applied.model || m.requests_none() }), patch: { model: null } });
  }
  if (applied.connectionId !== null) {
    chips.push({
      key: "connection",
      label: m.requests_chip_connection({ name: applied.connectionId === "" ? m.requests_none() : connectionLabel(applied.connectionId, connections) }),
      patch: { connectionId: null },
    });
  }
  if (applied.keyId) {
    const key = keys.find((item) => item.id === applied.keyId);
    chips.push({ key: "key", label: m.requests_chip_key({ name: key ? `${key.name} ${key.prefix}` : applied.keyId }), patch: { keyId: "" } });
  }
  if (applied.outcome) chips.push({ key: "outcome", label: m.requests_chip_outcome({ name: outcomeLabel(applied.outcome) }), patch: { outcome: "" } });
  if (applied.endpoint) chips.push({ key: "endpoint", label: m.requests_chip_endpoint({ name: applied.endpoint }), patch: { endpoint: "" } });
  if (chips.length === 0) return null;
  return (
    <div className="req-chips" aria-label={m.requests_active_filters()}>
      {chips.map((chip) => (
        <button key={chip.key} type="button" className="badge neutral req-chip" onClick={() => onRemove(chip.patch)}>
          {chip.label} <span aria-hidden="true">×</span>
          <span className="visually-hidden">{m.action_remove()}</span>
        </button>
      ))}
    </div>
  );
}

function RequestList({
  list,
  extraFilters,
  connections,
  selectedId,
  loadingMore,
  moreError,
  onOpen,
  onRetry,
  onOlder,
}: {
  list: { status: "loading" } | { status: "error"; message: string } | { status: "ready"; rows: RequestRow[]; nextBefore: string | null };
  extraFilters: boolean;
  connections: Connection[];
  selectedId: string | null;
  loadingMore: boolean;
  moreError: string | null;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onOlder: () => void;
}) {
  if (list.status === "loading") return <p className="empty">{m.requests_loading()}</p>;
  if (list.status === "error") {
    return (
      <div className="stack">
        <p className="banner error" role="alert">{list.message}</p>
        <div className="row-actions"><button type="button" onClick={onRetry}>{m.action_retry()}</button></div>
      </div>
    );
  }
  if (list.rows.length === 0) {
    return (
      <div className="empty">
        <strong>{extraFilters ? m.requests_empty_filtered_title() : m.requests_empty_title()}</strong>
        {extraFilters ? m.requests_empty_filtered_body() : m.requests_empty_body()}
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="req-table-wrap">
        <table className="req-table">
          <caption className="visually-hidden">{m.requests_caption()}</caption>
          <thead>
            <tr>
              <th>{m.label_time()}</th>
              <th>{m.label_connection()}</th>
              <th>{m.label_api_key()}</th>
              <th>{m.label_model()}</th>
              <th>{m.label_stream()}</th>
              <th>{m.label_tokens()}</th>
              <th>{m.label_timing()}</th>
              <th>{m.label_status()}</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((row) => (
              <tr
                key={row.id}
                data-request-id={row.id}
                tabIndex={0}
                role="button"
                aria-label={m.requests_open({ id: row.id })}
                aria-selected={selectedId === row.id}
                className={selectedId === row.id ? "is-selected" : undefined}
                onClick={(event) => {
                  event.currentTarget.focus();
                  onOpen(row.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.currentTarget.focus();
                    onOpen(row.id);
                  }
                }}
              >
                <td><time dateTime={row.startedAt}>{formatTime(row.startedAt)}</time></td>
                <td>
                  <div>{connectionLabel(row.connectionId, connections)}</div>
                  {row.attemptCount > 1 ? <div className="meta">{m.count_attempts({ count: row.attemptCount })}</div> : null}
                </td>
                <td>{row.apiKeyPrefix || "—"}</td>
                <td>
                  <div>{row.requestModel || "—"}</div>
                  {row.upstreamModel && row.upstreamModel !== row.requestModel ? <div className="meta">{m.requests_upstream({ model: row.upstreamModel })}</div> : null}
                </td>
                <td>
                  <div>{row.stream ? m.requests_stream() : m.requests_non_stream()}</div>
                  <div className="meta">{m.requests_tps({ value: formatTps(rowTps(row)) })}</div>
                </td>
                <td>
                  <div>{tokenPair(row.inputTokens, row.outputTokens)}</div>
                  {cacheLine(row) ? <div className="meta">{cacheLine(row)}</div> : null}
                </td>
                <td>
                  {row.stream ? <div>{m.requests_first_token({ duration: formatDuration(row.ttfbMs) })}</div> : null}
                  <div>{formatDuration(row.durationMs)}</div>
                </td>
                <td>
                  <div className="req-status">
                    <OutcomeBadge outcome={row.outcome} />
                    <span>{row.status}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="req-cards">
        {list.rows.map((row) => (
          <button
            key={row.id}
            type="button"
            data-request-id={row.id}
            className={selectedId === row.id ? "req-card is-selected" : "req-card"}
            aria-pressed={selectedId === row.id}
            onClick={(event) => {
              event.currentTarget.focus();
              onOpen(row.id);
            }}
          >
            <span className="req-card-top">
              <time dateTime={row.startedAt}>{formatTime(row.startedAt)}</time>
              <OutcomeBadge outcome={row.outcome} />
            </span>
            <strong>{row.requestModel || "—"}</strong>
            <span>{tokenPair(row.inputTokens, row.outputTokens)}</span>
            <span className="meta">{m.requests_tps({ value: formatTps(rowTps(row)) })}</span>
          </button>
        ))}
      </div>
      {moreError ? <p className="banner error" role="alert">{moreError}</p> : null}
      {list.nextBefore ? (
        <div className="row-actions">
          <button type="button" onClick={onOlder} disabled={loadingMore}>{loadingMore ? m.busy_loading() : m.action_older()}</button>
        </div>
      ) : null}
    </div>
  );
}

function StatisticsView({
  stats,
  connections,
  onRetry,
  onModel,
  onConnection,
}: {
  stats: { status: "idle" | "loading" } | { status: "error"; message: string } | { status: "ready"; stats: RangeStats };
  connections: Connection[];
  onRetry: () => void;
  onModel: (model: string) => void;
  onConnection: (connectionId: string) => void;
}) {
  if (stats.status !== "ready") {
    if (stats.status === "error") {
      return (
        <div className="stack">
          <p className="banner error" role="alert">{stats.message}</p>
          <div className="row-actions"><button type="button" onClick={onRetry}>{m.action_retry()}</button></div>
        </div>
      );
    }
    return <p className="empty">{m.requests_loading_stats()}</p>;
  }
  const data = stats.stats;
  const maxRequests = Math.max(1, ...data.series.map((row) => row.requests));
  return (
    <div className="stack">
      <p className="meta">
        {m.requests_kept({ from: formatTime(data.from), to: formatTime(data.to) })}
      </p>
      <div className="req-metrics">
        <Metric label={m.requests_tab_requests()} value={formatCount(data.requests)} />
        <Metric label={m.requests_errors()} value={formatCount(data.errors)} />
        <Metric label={m.requests_aborted()} value={formatCount(data.aborted)} />
        <Metric label={m.requests_error_rate()} value={formatPercent(data.errorRate)} />
        <Metric label={m.requests_rpm()} value={m.requests_rpm_value({ value: formatRate(data.rpm) })} />
        <Metric label={m.requests_tpm()} value={m.requests_tpm_value({ value: formatRate(data.tpm) })} />
        <Metric label={m.requests_input_tokens()} value={`${formatCount(data.inputTokens)} · ${m.requests_per_min({ value: formatRate(data.inputTpm) })}`} />
        <Metric label={m.requests_output_tokens()} value={`${formatCount(data.outputTokens)} · ${m.requests_per_min({ value: formatRate(data.outputTpm) })}`} />
        <Metric label={m.requests_cache_read()} value={`${formatCount(data.cacheReadTokens)} · ${m.requests_per_min({ value: formatRate(data.cacheReadTpm) })}`} />
        <Metric label={m.requests_cache_write()} value={`${formatCount(data.cacheWriteTokens)} · ${m.requests_per_min({ value: formatRate(data.cacheWriteTpm) })}`} />
        <Metric label={m.requests_avg_duration()} value={formatDuration(data.avgDurationMs)} />
        <Metric label={m.requests_avg_first()} value={formatDuration(data.avgTtfbMs)} />
        <Metric label={m.requests_output_tps()} value={data.outputTps == null ? "—" : m.requests_tps_value({ value: formatTps(data.outputTps) })} />
      </div>
      {data.requests === 0 ? (
        <div className="empty">
          <strong>{m.requests_stats_empty()}</strong>
          {m.requests_range_empty_body()}
        </div>
      ) : null}
      <div className="req-scroll">
        <table className="req-table req-stats-table">
          <caption>{m.requests_series()}</caption>
          <thead>
            <tr>
              <th>{m.label_time()}</th>
              <th>{m.requests_tab_requests()}</th>
              <th>{m.requests_errors()}</th>
              <th>{m.requests_input()}</th>
              <th>{m.requests_output()}</th>
              <th>{m.requests_cache_read()}</th>
              <th>{m.requests_cache_write()}</th>
            </tr>
          </thead>
          <tbody>
            {data.series.length === 0 ? (
              <tr><td colSpan={7}>{m.requests_buckets_empty()}</td></tr>
            ) : data.series.map((row) => (
              <tr key={row.t}>
                <td>{formatTime(row.t)}</td>
                <td>
                  <div className="req-bar-row">
                    <span className="req-bar" aria-hidden="true"><span style={{ width: `${(row.requests / maxRequests) * 100}%` }} /></span>
                    <span>{formatCount(row.requests)}</span>
                  </div>
                </td>
                <td>{formatCount(row.errors)}</td>
                <td>{formatCount(row.inputTokens)}</td>
                <td>{formatCount(row.outputTokens)}</td>
                <td>{formatCount(row.cacheReadTokens)}</td>
                <td>{formatCount(row.cacheWriteTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="req-scroll">
        <table className="req-table req-stats-table">
          <caption>{m.requests_by_model()}</caption>
          <thead>
            <tr>
              <th>{m.label_model()}</th>
              <th>{m.requests_tab_requests()}</th>
              <th>{m.requests_errors()}</th>
              <th>{m.requests_input()}</th>
              <th>{m.requests_output()}</th>
              <th>{m.requests_cache_read()}</th>
              <th>{m.requests_cache_write()}</th>
            </tr>
          </thead>
          <tbody>
            {data.byModel.length === 0 ? <tr><td colSpan={7}>{m.requests_models_empty()}</td></tr> : data.byModel.map((row) => (
              <tr key={row.model || "(none)"}>
                <td>
                  <button type="button" className="req-facet" onClick={() => onModel(row.model)}>
                    {row.model || m.requests_none()}
                  </button>
                </td>
                <td>{formatCount(row.requests)}</td>
                <td>{formatCount(row.errors)}</td>
                <td>{formatCount(row.inputTokens)}</td>
                <td>{formatCount(row.outputTokens)}</td>
                <td>{formatCount(row.cacheReadTokens)}</td>
                <td>{formatCount(row.cacheWriteTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="req-scroll">
        <table className="req-table req-stats-table">
          <caption>{m.requests_by_connection()}</caption>
          <thead>
            <tr>
              <th>{m.label_connection()}</th>
              <th>{m.label_provider()}</th>
              <th>{m.requests_tab_requests()}</th>
              <th>{m.requests_errors()}</th>
              <th>{m.requests_input()}</th>
              <th>{m.requests_output()}</th>
              <th>{m.requests_cache_read()}</th>
              <th>{m.requests_cache_write()}</th>
            </tr>
          </thead>
          <tbody>
            {data.byConnection.length === 0 ? <tr><td colSpan={8}>{m.requests_connections_empty()}</td></tr> : data.byConnection.map((row) => (
              <tr key={`${row.connectionId}:${row.providerId}`}>
                <td>
                  <button type="button" className="req-facet" onClick={() => onConnection(row.connectionId)}>
                    {row.connectionId ? connectionLabel(row.connectionId, connections) : m.requests_none()}
                  </button>
                </td>
                <td>{row.providerId || "—"}</td>
                <td>{formatCount(row.requests)}</td>
                <td>{formatCount(row.errors)}</td>
                <td>{formatCount(row.inputTokens)}</td>
                <td>{formatCount(row.outputTokens)}</td>
                <td>{formatCount(row.cacheReadTokens)}</td>
                <td>{formatCount(row.cacheWriteTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RequestDetail({
  id,
  detail,
  connections,
  onClose,
}: {
  id: string;
  detail: DetailState;
  connections: Connection[];
  onClose: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const panel = panelRef.current;
    const previously = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      panel
        ? [...panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
            (element) => !element.hasAttribute("disabled"),
          )
        : [];
    focusable()[0]?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const active = document.activeElement;
      const movedToRow = active instanceof HTMLElement && active.dataset.requestId;
      if (!movedToRow) previously?.focus();
    };
  }, []);
  const record = detail.status === "ready" ? detail.request : null;
  return (
    <div className="dialog-backdrop detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className="dialog detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="detail-header">
          <h2 id={titleId}>{m.requests_title({ id })}</h2>
          <button type="button" onClick={onClose}>{m.action_close()}</button>
        </header>
        <div className="detail-body">
          {detail.status === "loading" ? <p className="empty">{m.requests_loading_one()}</p> : null}
          {detail.status === "missing" ? (
            <div className="empty">
              <strong>{m.requests_missing_title()}</strong>
              {m.requests_missing_body()}
            </div>
          ) : null}
          {detail.status === "error" ? <p className="banner error" role="alert">{detail.message}</p> : null}
          {record ? (
            <>
              <dl className="meta-list">
                <div><dt>{m.label_endpoint()}</dt><dd>{record.endpoint}</dd></div>
                <div><dt>{m.requests_usage_source()}</dt><dd>{usageSourceLabel(record.usageSource)}</dd></div>
                <div><dt>{m.label_status()}</dt><dd>{record.status}</dd></div>
                <div><dt>{m.label_outcome()}</dt><dd><OutcomeBadge outcome={record.outcome} /></dd></div>
                <div><dt>{m.label_tokens()}</dt><dd>{tokenPair(record.inputTokens, record.outputTokens)}</dd></div>
                <div><dt>{m.requests_cache_read()}</dt><dd>{record.cacheReadTokens ?? "—"}</dd></div>
                <div><dt>{m.requests_cache_write()}</dt><dd>{record.cacheWriteTokens ?? "—"}</dd></div>
                <div><dt>{m.requests_duration()}</dt><dd>{formatDuration(record.durationMs)}</dd></div>
                {record.stream ? <div><dt>{m.requests_first_token_label()}</dt><dd>{formatDuration(record.ttfbMs)}</dd></div> : null}
                <div><dt>TPS</dt><dd>{formatTps(rowTps(record))}</dd></div>
                <div><dt>{m.label_model()}</dt><dd>{record.requestModel || "—"}</dd></div>
                <div><dt>{m.requests_upstream_model()}</dt><dd>{record.upstreamModel || "—"}</dd></div>
                <div><dt>{m.label_connection()}</dt><dd>{connectionLabel(record.connectionId, connections)}</dd></div>
                <div><dt>{m.label_api_key()}</dt><dd>{record.apiKeyPrefix || "—"}</dd></div>
              </dl>
              {record.error ? <p className="banner error" role="alert">{record.error}</p> : null}
              <h3>{detail.status === "ready" && detail.attempts.length > 1 ? m.requests_retry_chain() : m.requests_attempts()}</h3>
              {detail.status === "ready" && detail.attempts.length === 0 ? <p className="empty">{m.requests_no_attempts()}</p> : null}
              {detail.status === "ready" && detail.attempts.length > 0 ? (
                <ol className="req-attempts">
                  {detail.attempts.map((attempt) => (
                    <li key={attempt.seq}>
                      <strong>{m.requests_attempt({ seq: String(attempt.seq) })}</strong>
                      <dl className="meta-list">
                        <div><dt>{m.label_provider()}</dt><dd>{attempt.providerId}</dd></div>
                        <div><dt>{m.label_connection()}</dt><dd>{connectionLabel(attempt.connectionId, connections)}</dd></div>
                        <div><dt>{m.requests_upstream_model()}</dt><dd>{attempt.upstreamModel || "—"}</dd></div>
                        <div><dt>{m.label_status()}</dt><dd>{attempt.status ?? "—"}</dd></div>
                        <div><dt>{m.requests_duration()}</dt><dd>{formatDuration(attempt.durationMs)}</dd></div>
                        {attempt.error ? <div><dt>{m.requests_errors()}</dt><dd>{attempt.error}</dd></div> : null}
                      </dl>
                    </li>
                  ))}
                </ol>
              ) : null}
              <div className="resource-title-row">
                <h3>{m.requests_payload_request()}</h3>
                {record.payloadTruncated ? <span className="badge warn">{m.status_truncated()}</span> : null}
              </div>
              {detail.status === "ready" && detail.payload == null ? (
                <div className="empty">
                  <strong>{m.requests_no_payload_title()}</strong>
                  {m.requests_no_payload_body()}
                </div>
              ) : detail.status === "ready" ? (
                <>
                  <pre className="payload-pre">{formatJson(detail.payload?.request)}</pre>
                  <h3>{m.requests_payload_response()}</h3>
                  <pre className="payload-pre">{formatJson(detail.payload?.response)}</pre>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="req-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const tone = outcome === "success" ? "ok" : outcome === "aborted" ? "warn" : "error";
  return <span className={`badge ${tone}`}>{outcomeLabel(outcome)}</span>;
}

function defaultFilters(): Filters {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return {
    fromLocal: toDatetimeLocal(from),
    toLocal: toDatetimeLocal(to),
    model: null,
    connectionId: null,
    keyId: "",
    outcome: "",
    endpoint: "",
  };
}

function sameFilters(left: Filters, right: Filters): boolean {
  return left.fromLocal === right.fromLocal
    && left.toLocal === right.toLocal
    && left.model === right.model
    && left.connectionId === right.connectionId
    && left.keyId === right.keyId
    && left.outcome === right.outcome
    && left.endpoint === right.endpoint;
}

function search(filters: Filters, before?: string): string {
  const params = new URLSearchParams();
  params.set("from", localMinuteIso(filters.fromLocal, "start"));
  params.set("to", localMinuteIso(filters.toLocal, "end"));
  if (filters.model !== null) params.set("model", filters.model);
  if (filters.connectionId !== null) params.set("connectionId", filters.connectionId);
  if (filters.keyId) params.set("keyId", filters.keyId);
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.endpoint) params.set("endpoint", filters.endpoint);
  if (before) params.set("before", before);
  return params.toString();
}

function localMinuteIso(value: string, edge: "start" | "end"): string {
  const parsed = new Date(value);
  parsed.setSeconds(edge === "start" ? 0 : 59, edge === "start" ? 0 : 999);
  return parsed.toISOString();
}

function connectionLabel(id: string | null, connections: Connection[]): string {
  if (!id) return "—";
  const found = connections.find((connection) => connection.id === id);
  return found?.displayLabel?.trim() || id;
}

function connectionOption(connection: Connection): string {
  const label = connection.displayLabel?.trim() || connection.id;
  return label === connection.id ? connection.id : `${label} (${connection.id})`;
}

function rowTps(row: Pick<RequestRow, "outputTokens" | "durationMs">): number | null {
  if (row.outputTokens == null || row.outputTokens <= 0 || row.durationMs <= 0) return null;
  return row.outputTokens / (row.durationMs / 1000);
}

function formatTps(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round((ms / 1000) * 10) / 10;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

function formatTime(iso: string): string {
  return formatDateTime(iso);
}

function formatPercent(rate: number): string {
  const percent = Math.round(rate * 1000) / 10;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

function tokenPair(input: number | null, output: number | null): string {
  return `${input ?? "—"} / ${output ?? "—"}`;
}

function cacheLine(row: Pick<RequestRow, "cacheReadTokens" | "cacheWriteTokens">): string | null {
  const parts: string[] = [];
  if ((row.cacheReadTokens ?? 0) > 0) parts.push(m.requests_cache_read_line({ count: formatCount(row.cacheReadTokens ?? 0) }));
  if ((row.cacheWriteTokens ?? 0) > 0) parts.push(m.requests_cache_write_line({ count: formatCount(row.cacheWriteTokens ?? 0) }));
  return parts.length > 0 ? parts.join(" / ") : null;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function toDatetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function messageOf(error: unknown, fallback: string): string {
  return isApiError(error) ? error.message : fallback;
}

function outcomeLabel(outcome: string): string {
  if (outcome === "success") return m.outcome_success();
  if (outcome === "upstream_error") return m.outcome_upstream_error();
  if (outcome === "client_error") return m.outcome_client_error();
  if (outcome === "aborted") return m.outcome_aborted();
  if (outcome === "timeout") return m.outcome_timeout();
  if (outcome === "auth_error") return m.outcome_auth_error();
  return outcome;
}

function usageSourceLabel(source: string): string {
  if (source === "parser") return m.usage_source_parser();
  if (source === "missing") return m.usage_source_missing();
  return source;
}
