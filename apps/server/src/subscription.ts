import type { FastifyBaseLogger } from "fastify";
import type { ProviderHandler, SubscriptionResult, SubscriptionUsage } from "@viateai/sdk";
import { pluginLoggerFromFastify } from "./plugin-log.js";
import type { AdminStore, StoredConnection, StoredSubscriptionUsage, SubscriptionUnit } from "./store.js";

export const SUBSCRIPTION_DUE_MIN_MS = 60_000;
export const SUBSCRIPTION_DUE_DEFAULT_MS = 10 * 60_000;
export const SUBSCRIPTION_DUE_MAX_MS = 6 * 60 * 60_000;
export const SUBSCRIPTION_BACKOFF_MIN_MS = 60_000;
export const SUBSCRIPTION_BACKOFF_MAX_MS = 15 * 60_000;
export const SUBSCRIPTION_STALE_MS = 15 * 60_000;
export const SUBSCRIPTION_SPACING_MS = 1_500;
export const SUBSCRIPTION_FETCH_TIMEOUT_MS = 30_000;
const SUBSCRIPTION_WATCHDOG_MS = 60_000;

export type SubscriptionLevel = "ok" | "low" | "exhausted" | "unknown";

export type SubscriptionUsageView = {
  type: string;
  group: string | null;
  label: string;
  unit: SubscriptionUnit;
  currency: string | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null;
  unlimited: boolean;
  reported: boolean;
  level: SubscriptionLevel;
};

export type SubscriptionView = {
  connectionId: string;
  providerId: string;
  displayLabel: string;
  active: boolean;
  hasCredentials: boolean;
  orphan: boolean;
  support: "supported" | "unsupported";
  status: "unknown" | "ok" | "failed" | "needs_reauth" | "unsupported";
  error: string | null;
  plan: string | null;
  fetchedAt: string | null;
  dueAt: string | null;
  stale: boolean;
  level: SubscriptionLevel;
  usages: SubscriptionUsageView[];
};

type NormalizedUsage = Omit<StoredSubscriptionUsage, "connectionId">;

type NormalizedSubscription =
  | { status: "ok"; plan: string | null; usages: NormalizedUsage[]; nextDueMs: number }
  | { status: "failed" | "needs_reauth"; error: string };

export type SubscriptionScheduler = {
  start(): void;
  refresh(connectionId: string): Promise<SubscriptionView>;
  stop(): void;
};

export function usageLevel(usage: {
  unit: SubscriptionUnit;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
  reported: boolean;
}): SubscriptionLevel {
  if (!usage.reported) {
    return "unknown";
  }
  if (usage.unlimited) {
    return "ok";
  }
  if (usage.unit === "percent") {
    const used = usage.used ?? (usage.remaining === null ? null : 100 - usage.remaining);
    if (used === null) {
      return "unknown";
    }
    if (used >= 100) {
      return "exhausted";
    }
    if (used >= 80) {
      return "low";
    }
    return "ok";
  }
  const remaining =
    usage.remaining ??
    (usage.limit !== null && usage.used !== null ? Math.max(usage.limit - usage.used, 0) : null);
  if (usage.limit !== null && usage.limit > 0 && remaining !== null) {
    const ratio = remaining / usage.limit;
    if (ratio <= 0) {
      return "exhausted";
    }
    if (ratio <= 0.2) {
      return "low";
    }
    return "ok";
  }
  if (remaining === 0) {
    return "exhausted";
  }
  return "unknown";
}

export function normalizeSubscriptionResult(
  value: unknown,
): { accepted: true; result: NormalizedSubscription } | { accepted: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { accepted: false, error: "subscription status is invalid" };
  }
  const result = value as SubscriptionResult;
  if (result.status !== "ok" && result.status !== "failed" && result.status !== "needs_reauth") {
    return { accepted: false, error: "subscription status is invalid" };
  }
  if (result.status !== "ok") {
    return { accepted: true, result: { status: result.status, error: publicError(result.error) } };
  }
  if (!Array.isArray(result.usages)) {
    return { accepted: false, error: "usages are required" };
  }
  const usages: NormalizedUsage[] = [];
  const seen: Record<string, true> = {};
  for (const [position, usage] of result.usages.entries()) {
    const normalized = normalizeUsage(usage, position);
    if ("error" in normalized) {
      return { accepted: false, error: normalized.error };
    }
    if (seen[normalized.type]) {
      return { accepted: false, error: "duplicate usage type" };
    }
    seen[normalized.type] = true;
    usages.push(normalized);
  }
  const plan = typeof result.plan === "string" && result.plan.trim() ? result.plan.trim().slice(0, 120) : null;
  return {
    accepted: true,
    result: { status: "ok", plan, usages, nextDueMs: clampDue(result.nextDueMs) },
  };
}

export function buildSubscriptionViews(store: AdminStore, providers: Map<string, ProviderHandler>, now = Date.now()): SubscriptionView[] {
  const usages = new Map<string, StoredSubscriptionUsage[]>();
  for (const usage of store.listSubscriptionUsages()) {
    const rows = usages.get(usage.connectionId) ?? [];
    rows.push(usage);
    usages.set(usage.connectionId, rows);
  }
  return store.listConnections().map((connection) => toView(connection, usages.get(connection.id) ?? [], providers, now));
}

export function createSubscriptionScheduler(options: {
  store: AdminStore;
  providers: Map<string, ProviderHandler>;
  log: FastifyBaseLogger;
  spacingMs?: number;
  fetchTimeoutMs?: number;
}): SubscriptionScheduler {
  const { store, providers, log } = options;
  const spacingMs = options.spacingMs ?? SUBSCRIPTION_SPACING_MS;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? SUBSCRIPTION_FETCH_TIMEOUT_MS;
  const timers = new Map<string, NodeJS.Timeout>();
  const inflight = new Map<string, Promise<SubscriptionView>>();
  const stagger: NodeJS.Timeout[] = [];
  const tails = new Map<string, Promise<void>>();
  const backoffDelay = new Map<string, number>();
  const backoffUntil = new Map<string, number>();
  const pending = new Set<string>();
  let watchdog: NodeJS.Timeout | undefined;
  let stopped = false;

  const clearTimer = (connectionId: string): void => {
    const timer = timers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(connectionId);
    }
  };

  const schedule = (connectionId: string, delayMs: number): void => {
    clearTimer(connectionId);
    const timer = setTimeout(() => {
      timers.delete(connectionId);
      const stored = store.getConnection(connectionId);
      if (!stored?.active || !stored.hasCredentials || !providers.get(stored.providerId)?.subscription) {
        return;
      }
      void refresh(connectionId).catch((error: unknown) => {
        log.error({ err: error, connectionId }, "subscription refresh failed");
      });
    }, delayMs);
    timer.unref();
    timers.set(connectionId, timer);
  };

  const enqueue = (providerId: string, job: () => Promise<void>): void => {
    const previous = tails.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await job();
    });
    tails.set(providerId, next);
  };

  const pull = async (connectionId: string): Promise<SubscriptionView> => {
    const stored = requireRefreshable(store, providers, connectionId);
    const provider = providers.get(stored.providerId);
    if (!provider?.subscription) {
      throw httpError(400, "provider does not support subscription");
    }
    let normalized: NormalizedSubscription;
    try {
      const result = await provider.subscription({
        connectionId,
        credentials: store.getCredentials(connectionId),
        signal: AbortSignal.timeout(fetchTimeoutMs),
        log: pluginLoggerFromFastify(log).child({ plugin: stored.providerId, connectionId }),
      });
      const accepted = normalizeSubscriptionResult(result);
      if (!accepted.accepted) {
        normalized = { status: "failed", error: accepted.error };
      } else {
        normalized = accepted.result;
      }
    } catch (error) {
      normalized = { status: "failed", error: publicError(error) };
    }
    if (normalized.status === "ok") {
      const dueAt = new Date(Date.now() + normalized.nextDueMs).toISOString();
      store.saveSubscriptionSuccess(connectionId, { plan: normalized.plan, dueAt, usages: normalized.usages });
      backoffDelay.delete(connectionId);
      backoffUntil.delete(connectionId);
      if (store.getConnection(connectionId)?.active) {
        schedule(connectionId, normalized.nextDueMs);
      } else {
        clearTimer(connectionId);
      }
    } else {
      store.saveSubscriptionFailure(connectionId, normalized.status, normalized.error);
      log.warn({ connectionId, providerId: stored.providerId, status: normalized.status, error: normalized.error }, "subscription refresh failed");
      if (normalized.status === "needs_reauth") {
        backoffDelay.delete(connectionId);
        backoffUntil.delete(connectionId);
        clearTimer(connectionId);
      } else {
        const delay = backoffDelay.get(connectionId) ?? SUBSCRIPTION_BACKOFF_MIN_MS;
        backoffDelay.set(connectionId, Math.min(delay * 2, SUBSCRIPTION_BACKOFF_MAX_MS));
        backoffUntil.set(connectionId, Date.now() + delay);
        if (store.getConnection(connectionId)?.active) {
          schedule(connectionId, delay);
        } else {
          clearTimer(connectionId);
        }
      }
    }
    const view = buildSubscriptionViews(store, providers).find((candidate) => candidate.connectionId === connectionId);
    if (!view) {
      throw httpError(404, "connection not found");
    }
    return view;
  };

  const refresh = (connectionId: string): Promise<SubscriptionView> => {
    if (stopped) {
      return Promise.reject(httpError(503, "subscription scheduler stopped"));
    }
    const existing = inflight.get(connectionId);
    if (existing) {
      return existing;
    }
    let providerId: string;
    try {
      providerId = requireRefreshable(store, providers, connectionId).providerId;
    } catch (error) {
      return Promise.reject(error);
    }
    const promise = new Promise<SubscriptionView>((resolve, reject) => {
      enqueue(providerId, async () => {
        if (stopped) {
          reject(httpError(503, "subscription scheduler stopped"));
          return;
        }
        try {
          resolve(await pull(connectionId));
        } catch (error) {
          reject(error);
        }
      });
    }).finally(() => {
      if (inflight.get(connectionId) === promise) {
        inflight.delete(connectionId);
      }
      if (pending.has(connectionId)) {
        pending.delete(connectionId);
        if (!stopped) {
          void refresh(connectionId).catch((error: unknown) => {
            log.error({ err: error, connectionId }, "subscription refresh failed");
          });
        }
      }
    });
    inflight.set(connectionId, promise);
    return promise;
  };

  const consider = (connection: StoredConnection, force: boolean): void => {
    if (!connection.active || !connection.hasCredentials || !providers.get(connection.providerId)?.subscription) {
      return;
    }
    if (connection.subscriptionStatus === "needs_reauth") {
      return;
    }
    if (inflight.has(connection.id) || timers.has(connection.id)) {
      return;
    }
    const waiting = backoffUntil.get(connection.id);
    if (waiting && waiting > Date.now()) {
      return;
    }
    if (!force && connection.subscriptionStatus === "ok" && connection.subscriptionDueAt) {
      const due = Date.parse(connection.subscriptionDueAt);
      if (!Number.isNaN(due) && due > Date.now()) {
        return;
      }
    }
    void refresh(connection.id).catch((error: unknown) => {
      log.error({ err: error, connectionId: connection.id }, "subscription refresh failed");
    });
  };

  const unsubscribe = store.onCredentialsChanged((connectionId) => {
    const stored = store.getConnection(connectionId);
    if (!stored?.active || !stored.hasCredentials || !providers.get(stored.providerId)?.subscription) {
      return;
    }
    backoffDelay.delete(connectionId);
    backoffUntil.delete(connectionId);
    clearTimer(connectionId);
    if (inflight.has(connectionId)) {
      pending.add(connectionId);
      return;
    }
    void refresh(connectionId).catch((error: unknown) => {
      log.error({ err: error, connectionId }, "subscription refresh failed");
    });
  });

  return {
    start() {
      watchdog = setInterval(() => {
        for (const connection of store.listConnections()) {
          consider(connection, false);
        }
      }, SUBSCRIPTION_WATCHDOG_MS);
      watchdog.unref();
      let offset = 0;
      for (const connection of store.listConnections()) {
        if (!connection.active || !connection.hasCredentials || !providers.get(connection.providerId)?.subscription) {
          continue;
        }
        if (connection.subscriptionStatus === "needs_reauth") {
          continue;
        }
        const delay = offset;
        offset += spacingMs;
        const timer = setTimeout(() => {
          const current = store.getConnection(connection.id);
          if (current) {
            consider(current, true);
          }
        }, delay);
        timer.unref();
        stagger.push(timer);
      }
    },
    refresh,
    stop() {
      stopped = true;
      unsubscribe();
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = undefined;
      }
      for (const timer of stagger) {
        clearTimeout(timer);
      }
      stagger.length = 0;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}

function requireRefreshable(store: AdminStore, providers: Map<string, ProviderHandler>, connectionId: string): StoredConnection {
  const stored = store.getConnection(connectionId);
  if (!stored) {
    throw httpError(404, "connection not found");
  }
  if (!stored.hasCredentials) {
    throw httpError(400, "Save credentials before refreshing subscription");
  }
  if (!providers.has(stored.providerId)) {
    throw httpError(400, "Reinstall the plugin before refreshing subscription");
  }
  if (!providers.get(stored.providerId)?.subscription) {
    throw httpError(400, "provider does not support subscription");
  }
  return stored;
}

function toView(
  connection: StoredConnection,
  usages: StoredSubscriptionUsage[],
  providers: Map<string, ProviderHandler>,
  now: number,
): SubscriptionView {
  const supported = Boolean(providers.get(connection.providerId)?.subscription);
  const orphan = !providers.has(connection.providerId);
  if (!supported) {
    return {
      connectionId: connection.id,
      providerId: connection.providerId,
      displayLabel: connection.displayLabel,
      active: connection.active,
      hasCredentials: connection.hasCredentials,
      orphan,
      support: "unsupported",
      status: "unsupported",
      error: null,
      plan: null,
      fetchedAt: null,
      dueAt: null,
      stale: false,
      level: "unknown",
      usages: [],
    };
  }
  const viewed = usages.map((usage) => ({ ...usage, level: usageLevel(usage) }));
  return {
    connectionId: connection.id,
    providerId: connection.providerId,
    displayLabel: connection.displayLabel,
    active: connection.active,
    hasCredentials: connection.hasCredentials,
    orphan,
    support: "supported",
    status: connection.subscriptionStatus,
    error: connection.subscriptionError,
    plan: connection.subscriptionPlan,
    fetchedAt: connection.subscriptionAt,
    dueAt: connection.subscriptionDueAt,
    stale: stale(connection, usages.length > 0, now),
    level: worstLevel(viewed.map((usage) => usage.level)),
    usages: viewed.map(({ connectionId: _connectionId, position: _position, ...usage }) => usage),
  };
}

function stale(connection: StoredConnection, hasUsages: boolean, now: number): boolean {
  if (connection.subscriptionStatus === "unknown") {
    return false;
  }
  if (connection.subscriptionStatus !== "ok") {
    return hasUsages;
  }
  if (connection.subscriptionDueAt) {
    const due = Date.parse(connection.subscriptionDueAt);
    return !Number.isNaN(due) && due <= now;
  }
  if (!connection.subscriptionAt) {
    return false;
  }
  const fetched = Date.parse(connection.subscriptionAt);
  return !Number.isNaN(fetched) && now - fetched > SUBSCRIPTION_STALE_MS;
}

function worstLevel(levels: SubscriptionLevel[]): SubscriptionLevel {
  if (levels.includes("exhausted")) {
    return "exhausted";
  }
  if (levels.includes("low")) {
    return "low";
  }
  if (levels.includes("ok")) {
    return "ok";
  }
  return "unknown";
}

function normalizeUsage(value: unknown, position: number): NormalizedUsage | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "usage type is required" };
  }
  const usage = value as SubscriptionUsage;
  const type = typeof usage.type === "string" ? usage.type.trim() : "";
  const label = typeof usage.label === "string" ? usage.label.trim() : "";
  if (!type || type.length > 200) {
    return { error: "usage type is required" };
  }
  if (!label || label.length > 200) {
    return { error: "usage label is required" };
  }
  if (usage.unit !== "currency" && usage.unit !== "percent" && usage.unit !== "requests" && usage.unit !== "tokens") {
    return { error: "usage unit is invalid" };
  }
  const used = quantity(usage.used);
  const limit = quantity(usage.limit);
  const remaining = quantity(usage.remaining);
  if (used === "invalid" || limit === "invalid" || remaining === "invalid") {
    return { error: "usage numbers must be finite and non-negative" };
  }
  if (usage.unit === "percent") {
    if ((used !== null && used > 100) || (remaining !== null && remaining > 100) || (limit !== null && limit !== 100)) {
      return { error: "percent usage must be between 0 and 100" };
    }
  }
  let currency: string | null = null;
  if (usage.unit === "currency") {
    if (typeof usage.currency !== "string" || !/^[A-Z]{3}$/.test(usage.currency)) {
      return { error: "currency is required" };
    }
    currency = usage.currency;
  }
  const unlimited = flag(usage.unlimited, false);
  const reported = flag(usage.reported, true);
  if (unlimited === "invalid" || reported === "invalid") {
    return { error: "usage flags must be boolean" };
  }
  let resetsAt: string | null = null;
  if (usage.resetsAt !== undefined && usage.resetsAt !== null) {
    if (typeof usage.resetsAt !== "string" || Number.isNaN(Date.parse(usage.resetsAt))) {
      return { error: "resetsAt is invalid" };
    }
    resetsAt = new Date(usage.resetsAt).toISOString();
  }
  const group = typeof usage.group === "string" && usage.group.trim() ? usage.group.trim().slice(0, 80) : null;
  return { type, position, group, label, unit: usage.unit, currency, used, limit, remaining, resetsAt, unlimited, reported };
}

function quantity(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "invalid";
  }
  return value;
}

function flag(value: unknown, fallback: boolean): boolean | "invalid" {
  if (value === undefined) {
    return fallback;
  }
  return typeof value === "boolean" ? value : "invalid";
}

function clampDue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return SUBSCRIPTION_DUE_DEFAULT_MS;
  }
  return Math.min(SUBSCRIPTION_DUE_MAX_MS, Math.max(SUBSCRIPTION_DUE_MIN_MS, value));
}

function publicError(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "subscription refresh failed";
  const cleaned = raw
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\b(?:sk|key|tok)[-_][A-Za-z0-9_-]{6,}\b/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "subscription refresh failed").slice(0, 300);
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}
