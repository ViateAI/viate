export const AUTO_REFRESH_AFTER_MS = 30 * 60 * 1000;
export const SAME_PROVIDER_GAP_MIN_MS = 500;
export const SAME_PROVIDER_GAP_MAX_MS = 2_500;

export type AutoRefreshCandidate = {
  providerId: string;
  active: boolean;
  hasCredentials: boolean;
  orphan: boolean;
  support: "supported" | "unsupported";
  status: "unknown" | "ok" | "failed" | "needs_reauth" | "unsupported";
  fetchedAt: string | null;
};

export function canAutoRefresh(view: AutoRefreshCandidate, now: number): boolean {
  if (!view.active || view.orphan || !view.hasCredentials || view.support !== "supported") {
    return false;
  }
  if (view.status === "needs_reauth") {
    return false;
  }
  if (view.fetchedAt === null) {
    return true;
  }
  const fetched = Date.parse(view.fetchedAt);
  return !Number.isNaN(fetched) && now - fetched >= AUTO_REFRESH_AFTER_MS;
}

export function autoRefreshWaves<T extends { providerId: string }>(views: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const view of views) {
    const group = groups.get(view.providerId);
    if (group) {
      group.push(view);
    } else {
      groups.set(view.providerId, [view]);
    }
  }
  return [...groups.values()];
}

export function sameProviderGapMs(random: () => number = Math.random): number {
  return SAME_PROVIDER_GAP_MIN_MS + random() * (SAME_PROVIDER_GAP_MAX_MS - SAME_PROVIDER_GAP_MIN_MS);
}

export async function refreshProviderSequence<T>(
  views: readonly T[],
  options: {
    gapMs: () => number;
    wait: (ms: number) => Promise<void>;
    refresh: (view: T) => Promise<void>;
    cancelled: () => boolean;
  },
): Promise<void> {
  for (let index = 0; index < views.length; index += 1) {
    if (options.cancelled()) {
      return;
    }
    const view = views[index];
    if (view === undefined) {
      continue;
    }
    if (index > 0) {
      await options.wait(options.gapMs());
      if (options.cancelled()) {
        return;
      }
    }
    await options.refresh(view);
  }
}
