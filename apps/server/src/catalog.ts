import type { AdminStore, PublishedMember } from "./store.js";

export type RequestModel =
  | { kind: "aggregate"; modelId: string }
  | { kind: "pin"; providerId: string; modelId: string };

export function parseRequestModel(
  requestModel: string,
  loadedProviderIds: Iterable<string>,
): RequestModel {
  const trimmed = requestModel.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { kind: "aggregate", modelId: trimmed };
  }
  const providerId = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  const loaded: Record<string, true> = {};
  for (const id of loadedProviderIds) {
    loaded[id] = true;
  }
  if (!loaded[providerId]) {
    return { kind: "aggregate", modelId: trimmed };
  }
  return { kind: "pin", providerId, modelId };
}

export function resolvePublishedMembers(
  store: AdminStore,
  requestModel: string,
  loadedProviderIds: Iterable<string>,
): PublishedMember[] {
  const parsed = parseRequestModel(requestModel, loadedProviderIds);
  if (parsed.kind === "pin") {
    const pinned = store.listPublishedMembers({
      providerId: parsed.providerId,
      modelId: parsed.modelId,
    });
    if (pinned.length > 0) {
      return store.orderMembers(pinned);
    }
    return store.orderMembers(store.listPublishedMembers({ modelId: requestModel.trim() }));
  }
  return store.orderMembers(store.listPublishedMembers({ modelId: parsed.modelId }));
}
