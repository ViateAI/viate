import type { FastifyBaseLogger } from "fastify";
import type { ProviderConnection, ProviderHandler } from "@viateai/sdk";
import { pluginLoggerFromFastify } from "./plugin-log.js";
import type { AdminStore } from "./store.js";

export const KEEPALIVE_BACKOFF_MIN_MS = 60_000;
export const KEEPALIVE_BACKOFF_MAX_MS = 5 * 60_000;
export const KEEPALIVE_WATCHDOG_MS = 5 * 60_000;

const CORE_TIMEOUT_MS = 10 * 60 * 1_000;

export type KeepaliveReason = "timer" | "request";

export type KeepaliveScheduler = {
  start(): Promise<void>;
  nudge(connectionId: string, reason?: KeepaliveReason): void;
  stop(): void;
};

export function createKeepaliveScheduler(options: {
  store: AdminStore;
  providers: Map<string, ProviderHandler>;
  log: FastifyBaseLogger;
}): KeepaliveScheduler {
  const { store, providers, log } = options;
  const timers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<string>();
  const pending = new Map<string, KeepaliveReason>();
  const backoffMs = new Map<string, number>();
  const persistFromKeepalive = new Set<string>();
  let watchdog: NodeJS.Timeout | undefined;
  let stopped = false;

  const clearTimer = (connectionId: string): void => {
    const timer = timers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(connectionId);
    }
  };

  const schedule = (connectionId: string, delayMs: number, reason: KeepaliveReason = "timer"): void => {
    clearTimer(connectionId);
    const timer = setTimeout(() => {
      timers.delete(connectionId);
      nudge(connectionId, reason);
    }, delayMs);
    timer.unref();
    timers.set(connectionId, timer);
  };

  const nextBackoff = (connectionId: string): number => {
    const current = backoffMs.get(connectionId) ?? KEEPALIVE_BACKOFF_MIN_MS;
    backoffMs.set(connectionId, Math.min(current * 2, KEEPALIVE_BACKOFF_MAX_MS));
    return current;
  };

  const run = async (connection: ProviderConnection, reason: KeepaliveReason): Promise<void> => {
    const provider = providers.get(connection.providerId);
    if (!provider?.keepalive) {
      return;
    }
    if (inFlight.has(connection.connectionId)) {
      pending.set(connection.connectionId, reason);
      return;
    }
    inFlight.add(connection.connectionId);
    clearTimer(connection.connectionId);
    try {
      const result = await provider.keepalive({
        connectionId: connection.connectionId,
        credentials: connection.credentials,
        signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
        reason,
        log: pluginLoggerFromFastify(log).child({
          plugin: connection.providerId,
          connectionId: connection.connectionId,
        }),
      });
      if (result.credentials !== undefined || result.displayLabel !== undefined) {
        persistFromKeepalive.add(connection.connectionId);
        try {
          store.putCredentials(
            connection.connectionId,
            result.credentials === undefined ? connection.credentials : result.credentials,
            result.displayLabel,
          );
        } finally {
          persistFromKeepalive.delete(connection.connectionId);
        }
      }
      store.setKeepalive(connection.connectionId, result.status, result.error);
      if (result.status !== "ok") {
        log.warn(
          {
            connectionId: connection.connectionId,
            providerId: connection.providerId,
            status: result.status,
            error: result.error,
          },
          "keepalive failed",
        );
      }
      if (result.status === "needs_reauth") {
        backoffMs.delete(connection.connectionId);
        return;
      }
      if (result.status === "ok") {
        backoffMs.delete(connection.connectionId);
      }
      if (result.nextDueMs !== undefined) {
        schedule(connection.connectionId, result.nextDueMs);
      } else if (result.status === "failed") {
        schedule(connection.connectionId, nextBackoff(connection.connectionId));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.setKeepalive(connection.connectionId, "failed", message);
      log.error(
        {
          err: error,
          connectionId: connection.connectionId,
          providerId: connection.providerId,
          status: "failed",
          error: message,
        },
        "keepalive failed",
      );
      schedule(connection.connectionId, nextBackoff(connection.connectionId));
    } finally {
      inFlight.delete(connection.connectionId);
      const queued = pending.get(connection.connectionId);
      if (queued) {
        pending.delete(connection.connectionId);
        nudge(connection.connectionId, queued);
      }
    }
  };

  const nudge = (connectionId: string, reason: KeepaliveReason = "timer"): void => {
    if (stopped) {
      return;
    }
    const stored = store.getConnection(connectionId);
    if (!stored?.hasCredentials) {
      clearTimer(connectionId);
      pending.delete(connectionId);
      return;
    }
    if (!providers.get(stored.providerId)?.keepalive) {
      return;
    }
    if (inFlight.has(connectionId)) {
      pending.set(connectionId, reason);
      return;
    }
    void run(
      {
        connectionId,
        providerId: stored.providerId,
        credentials: store.getCredentials(connectionId),
      },
      reason,
    );
  };

  const unsubscribe = store.onCredentialsChanged((connectionId) => {
    if (persistFromKeepalive.has(connectionId)) {
      return;
    }
    nudge(connectionId, "timer");
  });

  const sweep = (): void => {
    for (const connection of store.listResolvedConnections()) {
      if (timers.has(connection.connectionId) || inFlight.has(connection.connectionId)) {
        continue;
      }
      if (store.getConnection(connection.connectionId)?.keepaliveStatus === "needs_reauth") {
        continue;
      }
      nudge(connection.connectionId, "timer");
    }
  };

  return {
    async start() {
      watchdog = setInterval(sweep, KEEPALIVE_WATCHDOG_MS);
      watchdog.unref();
      await Promise.all(
        store.listResolvedConnections().map((connection) => run(connection, "timer")),
      );
    },
    nudge,
    stop() {
      stopped = true;
      unsubscribe();
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = undefined;
      }
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      pending.clear();
    },
  };
}
