import { useEffect, useRef, useState } from "react";
import { formatMoney, formatNumber as formatLocaleNumber, formatRelativeTime } from "./format";
import { m } from "./paraglide/messages.js";
import { api, isApiError, type SubscriptionLevel, type SubscriptionUsageView, type SubscriptionView } from "./api";

const MODEL_PREVIEW = 6;

export function BalancesPage({
  focusId,
  onConfigure,
}: {
  focusId: string | null;
  onConfigure: (connectionId: string) => void;
}) {
  const [subscriptions, setSubscriptions] = useState<SubscriptionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [bulk, setBulk] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, true>>({});
  const alive = useRef(true);

  async function load() {
    const result = await api<{ subscriptions: SubscriptionView[] }>("/api/admin/subscriptions");
    setSubscriptions(result.subscriptions);
  }

  useEffect(() => {
    alive.current = true;
    load().catch((err) => setError(isApiError(err) ? err.message : m.error_load_balances()));
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!focusId || !subscriptions) {
      return;
    }
    document.getElementById(`balance-${focusId}`)?.scrollIntoView({ block: "start" });
  }, [focusId, subscriptions]);

  async function refreshOne(connectionId: string) {
    setRefreshing(connectionId);
    setError(null);
    try {
      const result = await api<{ subscription: SubscriptionView }>(
        `/api/admin/connections/${connectionId}/subscription/refresh`,
        { method: "POST" },
      );
      setSubscriptions((current) =>
        current?.map((item) => (item.connectionId === connectionId ? result.subscription : item)) ?? [result.subscription],
      );
    } catch (err) {
      setError(isApiError(err) ? err.message : m.error_refresh());
    } finally {
      setRefreshing((current) => (current === connectionId ? null : current));
    }
  }

  const sorted = [...(subscriptions ?? [])].sort(
    (left, right) => attention(left) - attention(right) || left.displayLabel.localeCompare(right.displayLabel),
  );
  const reporting = sorted.filter((item) => item.status === "ok").length;
  const exhausted = sorted.filter((item) => item.level === "exhausted").length;
  const low = sorted.filter((item) => item.level === "low").length;
  const failed = sorted.filter((item) => item.status === "failed").length;
  const summary = [
    reporting > 0 ? m.balances_summary_reporting({ count: String(reporting) }) : null,
    exhausted > 0 ? m.balances_summary_exhausted({ count: String(exhausted) }) : null,
    low > 0 ? m.balances_summary_low({ count: String(low) }) : null,
    failed > 0 ? m.balances_summary_failed({ count: String(failed) }) : null,
  ].filter((item) => item !== null);

  return (
    <section className="stack">
      <div className="toolbar">
        <button
          type="button"
          disabled={bulk !== null || sorted.every((item) => !canRefresh(item))}
          onClick={() => {
            const targets = sorted.filter(canRefresh);
            setBulk(`0/${targets.length}`);
            void (async () => {
              for (let index = 0; index < targets.length; index += 1) {
                if (!alive.current) {
                  return;
                }
                const target = targets[index];
                if (!target) {
                  continue;
                }
                setBulk(`${index + 1}/${targets.length}`);
                await refreshOne(target.connectionId);
              }
              if (alive.current) {
                setBulk(null);
              }
            })();
          }}
        >
          {bulk ? bulk : m.action_refresh_all()}
        </button>
      </div>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {summary.length > 0 ? <p className="meta">{summary.join(" · ")}</p> : null}
      {subscriptions === null && !error ? <p className="empty">{m.balances_loading()}</p> : null}
      {subscriptions && subscriptions.length === 0 ? (
        <div className="empty">
          <strong>{m.connections_empty_title()}</strong>
          {m.balances_empty_body()}
        </div>
      ) : null}
      {sorted.map((view) => (
        <article className="resource balance-card" id={`balance-${view.connectionId}`} key={view.connectionId}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{view.displayLabel || view.providerId}</h2>
              <StatusText tone={view.active ? "ok" : "neutral"}>{view.active ? m.status_active() : m.status_inactive()}</StatusText>
              <StatusText tone={statusTone(view)}>{statusLabel(view)}</StatusText>
            </div>
            <p className="meta">{view.plan ? `${view.plan} · ${view.providerId}` : view.providerId}</p>
            {view.error ? <p className="status warn" role="alert">{view.error}</p> : null}
            {view.status === "ok" && view.usages.length === 0 ? <p className="meta">{m.balances_no_usage()}</p> : null}
            {usageGroups(view.usages).map((group) => {
              const key = `${view.connectionId}:${group.group ?? ""}`;
              const collapsed = group.group === "Models" && group.usages.length > MODEL_PREVIEW && !expanded[key];
              const visible = collapsed ? group.usages.slice(0, MODEL_PREVIEW) : group.usages;
              const hidden = group.usages.length - visible.length;
              return (
                <section className="usage-group" key={key}>
                  {group.group ? (
                    <h3>
                      {group.group === "Models" ? m.usage_group_models() : group.group}
                      {group.group === "Models" ? <span className="meta"> {m.count_types({ count: group.usages.length })}</span> : null}
                    </h3>
                  ) : null}
                  <div className="usage-list">
                    {visible.map((usage) => (
                      <UsageRow key={usage.type} usage={usage} />
                    ))}
                  </div>
                  {hidden > 0 ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => setExpanded((current) => ({ ...current, [key]: true }))}
                    >
                      {m.show_more({ count: String(hidden) })}
                    </button>
                  ) : null}
                </section>
              );
            })}
            <p className="meta">
              {view.fetchedAt ? (
                <span title={view.fetchedAt}>
                  {view.stale
                    ? m.balances_updated_stale({ time: formatRelativeTime(view.fetchedAt) })
                    : m.balances_updated({ time: formatRelativeTime(view.fetchedAt) })}
                </span>
              ) : view.support === "supported" ? (
                m.balances_not_fetched()
              ) : (
                m.balances_unsupported()
              )}
            </p>
          </div>
          <div className="row-actions">
            {view.status === "needs_reauth" ? (
              <button type="button" onClick={() => onConfigure(view.connectionId)}>{m.action_configure()}</button>
            ) : null}
            {canRefresh(view) ? (
              <button type="button" disabled={refreshing === view.connectionId || bulk !== null} onClick={() => void refreshOne(view.connectionId)}>
                {refreshing === view.connectionId ? m.busy_refreshing() : m.action_refresh()}
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </section>
  );
}

function UsageRow({ usage }: { usage: SubscriptionUsageView }) {
  const percent = meterPercent(usage);
  return (
    <div className="usage-row">
      <div className="usage-label">
        <span>{usage.label}</span>
        <span>{usageText(usage)}</span>
        {usage.level === "low" || usage.level === "exhausted" ? <StatusText tone="warn">{usage.level === "low" ? m.status_low() : m.status_exhausted()}</StatusText> : null}
      </div>
      {percent === null ? null : (
        <div
          className={`usage-meter ${usage.level === "ok" ? "" : usage.level}`}
          role="meter"
          aria-label={usage.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      {usage.resetsAt ? <p className="meta" title={usage.resetsAt}>{m.usage_resets({ time: formatRelativeTime(usage.resetsAt) })}</p> : null}
    </div>
  );
}

function StatusText({ tone, children }: { tone: "ok" | "warn" | "neutral"; children: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function balanceSummary(view: SubscriptionView): string {
  if (view.support === "unsupported" || view.orphan) {
    return m.balance_not_reported();
  }
  if (view.usages.length === 0) {
    if (view.status === "failed") {
      return m.balance_failed();
    }
    if (view.status === "needs_reauth") {
      return m.balance_sign_in();
    }
    return m.balance_not_fetched();
  }
  const worst = worstUsage(view.usages);
  return m.balance_summary({
    label: worst.label,
    remainder: usageRemainder(worst),
    types: m.count_types({ count: view.usages.length }),
  });
}

function canRefresh(view: SubscriptionView): boolean {
  return view.support === "supported" && view.hasCredentials && !view.orphan;
}

function attention(view: SubscriptionView): number {
  if (view.support === "unsupported") {
    return 6;
  }
  if (view.level === "exhausted") {
    return 0;
  }
  if (view.level === "low") {
    return 1;
  }
  if (view.status === "failed") {
    return 2;
  }
  if (view.status === "needs_reauth") {
    return 3;
  }
  if (view.status === "ok") {
    return 4;
  }
  return 5;
}

function statusLabel(view: SubscriptionView): string {
  if (view.support === "unsupported") {
    return m.status_not_reported();
  }
  if (view.level === "exhausted") {
    return m.status_exhausted();
  }
  if (view.level === "low") {
    return m.status_low();
  }
  if (view.status === "failed") {
    return m.status_failed();
  }
  if (view.status === "needs_reauth") {
    return m.status_sign_in_again();
  }
  if (view.stale) {
    return m.status_stale();
  }
  if (view.status === "unknown") {
    return m.status_not_fetched();
  }
  return m.status_ok();
}

function statusTone(view: SubscriptionView): "ok" | "warn" | "neutral" {
  if (view.level === "low" || view.level === "exhausted" || view.status === "failed" || view.status === "needs_reauth" || view.stale) {
    return "warn";
  }
  if (view.status === "ok") {
    return "ok";
  }
  return "neutral";
}

function usageGroups(usages: SubscriptionUsageView[]): Array<{ group: string | null; usages: SubscriptionUsageView[] }> {
  const groups: Array<{ group: string | null; usages: SubscriptionUsageView[] }> = [];
  for (const usage of usages) {
    const last = groups[groups.length - 1];
    if (last && last.group === usage.group) {
      last.usages.push(usage);
    } else {
      groups.push({ group: usage.group, usages: [usage] });
    }
  }
  return groups;
}

function worstUsage(usages: SubscriptionUsageView[]): SubscriptionUsageView {
  const ranked = usages.filter((usage) => usage.reported && !usage.unlimited);
  const pool = ranked.length > 0 ? ranked : usages;
  return [...pool].sort((left, right) => levelRank(left.level) - levelRank(right.level) || usedRatio(right) - usedRatio(left))[0] ?? usages[0]!;
}

function levelRank(level: SubscriptionLevel): number {
  if (level === "exhausted") {
    return 0;
  }
  if (level === "low") {
    return 1;
  }
  if (level === "ok") {
    return 2;
  }
  return 3;
}

function usedRatio(usage: SubscriptionUsageView): number {
  if (usage.unit === "percent") {
    if (usage.used !== null) {
      return usage.used / 100;
    }
    if (usage.remaining !== null) {
      return (100 - usage.remaining) / 100;
    }
    return 0;
  }
  if (usage.limit && usage.limit > 0 && usage.remaining !== null) {
    return 1 - usage.remaining / usage.limit;
  }
  if (usage.limit && usage.limit > 0 && usage.used !== null) {
    return usage.used / usage.limit;
  }
  return 0;
}

function usageRemainder(usage: SubscriptionUsageView): string {
  if (!usage.reported) {
    return m.status_unknown();
  }
  if (usage.unlimited) {
    return m.status_unlimited();
  }
  if (usage.unit === "percent") {
    const left = usage.remaining ?? (usage.used === null ? null : 100 - usage.used);
    return left === null ? m.status_unknown() : m.usage_percent_left({ value: formatNumber(left) });
  }
  if (usage.remaining === null) {
    return m.status_unknown();
  }
  if (usage.unit === "currency") {
    return m.usage_amount_left({ amount: formatMoney(usage.remaining, usage.currency ?? "USD") });
  }
  return m.usage_amount_left({ amount: formatNumber(usage.remaining) });
}

function usageText(usage: SubscriptionUsageView): string {
  if (!usage.reported) {
    return m.status_unknown();
  }
  if (usage.unlimited) {
    return m.status_unlimited();
  }
  if (usage.unit === "percent") {
    const used = usage.used ?? (usage.remaining === null ? null : 100 - usage.remaining);
    const left = usage.remaining ?? (usage.used === null ? null : 100 - usage.used);
    if (used === null || left === null) {
      return m.status_unknown();
    }
    return m.usage_percent({ used: formatNumber(used), left: formatNumber(left) });
  }
  if (usage.unit === "currency") {
    const left = usage.remaining === null ? m.status_unknown() : m.usage_amount_left({ amount: formatMoney(usage.remaining, usage.currency ?? "USD") });
    if (usage.used !== null && usage.limit !== null) {
      return `${formatMoney(usage.used, usage.currency ?? "USD")} / ${formatMoney(usage.limit, usage.currency ?? "USD")} · ${left}`;
    }
    return left;
  }
  const left = usage.remaining === null ? m.status_unknown() : m.usage_amount_left({ amount: formatNumber(usage.remaining) });
  return usage.limit === null ? left : m.usage_limit({ left, limit: formatNumber(usage.limit) });
}

function meterPercent(usage: SubscriptionUsageView): number | null {
  if (!usage.reported || usage.unlimited) {
    return null;
  }
  if (usage.unit === "percent") {
    if (usage.used !== null) {
      return Math.max(0, Math.min(100, usage.used));
    }
    if (usage.remaining !== null) {
      return Math.max(0, Math.min(100, 100 - usage.remaining));
    }
    return null;
  }
  if (usage.limit && usage.limit > 0) {
    if (usage.used !== null) {
      return Math.max(0, Math.min(100, (usage.used / usage.limit) * 100));
    }
    if (usage.remaining !== null) {
      return Math.max(0, Math.min(100, (1 - usage.remaining / usage.limit) * 100));
    }
  }
  return null;
}

function formatNumber(value: number): string {
  return formatLocaleNumber(value, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
}
