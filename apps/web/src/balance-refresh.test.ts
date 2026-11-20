import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_REFRESH_AFTER_MS,
  SAME_PROVIDER_GAP_MAX_MS,
  SAME_PROVIDER_GAP_MIN_MS,
  autoRefreshWaves,
  canAutoRefresh,
  refreshProviderSequence,
  sameProviderGapMs,
  type AutoRefreshCandidate,
} from "./balance-refresh.ts";

const NOW = Date.parse("2026-01-01T00:30:00.000Z");

function candidate(overrides: Partial<AutoRefreshCandidate> = {}): AutoRefreshCandidate {
  return {
    providerId: "cursor",
    active: true,
    hasCredentials: true,
    orphan: false,
    support: "supported",
    status: "ok",
    fetchedAt: new Date(NOW - AUTO_REFRESH_AFTER_MS).toISOString(),
    ...overrides,
  };
}

describe("balance auto refresh", () => {
  it("refreshes only landed data that is at least 30 minutes old", () => {
    assert.equal(canAutoRefresh(candidate(), NOW), true);
    assert.equal(
      canAutoRefresh(candidate({ fetchedAt: new Date(NOW - AUTO_REFRESH_AFTER_MS + 1).toISOString() }), NOW),
      false,
    );
    assert.equal(canAutoRefresh(candidate({ fetchedAt: null, status: "unknown" }), NOW), true);
    assert.equal(canAutoRefresh(candidate({ status: "needs_reauth" }), NOW), false);
    assert.equal(canAutoRefresh(candidate({ active: false }), NOW), false);
    assert.equal(canAutoRefresh(candidate({ hasCredentials: false }), NOW), false);
    assert.equal(canAutoRefresh(candidate({ support: "unsupported", status: "unsupported" }), NOW), false);
  });

  it("keeps one wave per provider and preserves connection order inside it", () => {
    const first = { providerId: "cursor", connectionId: "1" };
    const other = { providerId: "gemini", connectionId: "2" };
    const second = { providerId: "cursor", connectionId: "3" };
    assert.deepEqual(autoRefreshWaves([first, other, second]), [[first, second], [other]]);
  });

  it("waits a random gap only between connections of the same provider", async () => {
    assert.equal(sameProviderGapMs(() => 0), SAME_PROVIDER_GAP_MIN_MS);
    assert.equal(sameProviderGapMs(() => 1), SAME_PROVIDER_GAP_MAX_MS);
    const waits: number[] = [];
    const refreshed: string[] = [];
    await refreshProviderSequence(["a", "b", "c"], {
      gapMs: () => 800,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      refresh: (connectionId) => {
        refreshed.push(connectionId);
        return Promise.resolve();
      },
      cancelled: () => false,
    });
    assert.deepEqual(refreshed, ["a", "b", "c"]);
    assert.deepEqual(waits, [800, 800]);
  });

  it("stops the provider wave when the page goes away during the gap", async () => {
    let cancelled = false;
    const refreshed: string[] = [];
    await refreshProviderSequence(["a", "b"], {
      gapMs: () => 800,
      wait: () => {
        cancelled = true;
        return Promise.resolve();
      },
      refresh: (connectionId) => {
        refreshed.push(connectionId);
        return Promise.resolve();
      },
      cancelled: () => cancelled,
    });
    assert.deepEqual(refreshed, ["a"]);
  });
});
