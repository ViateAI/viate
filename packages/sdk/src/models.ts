export type Model = {
  id: string;
  object: "model";
  owned_by?: string;
  name?: string;
};

export type ModelList = {
  object: "list";
  data: Model[];
};

export function modelList(models: Array<{ id: string; name?: string; owned_by?: string }>): ModelList {
  const data: Model[] = [];
  const seen: Record<string, true> = {};
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen[id]) {
      continue;
    }
    seen[id] = true;
    const name = model.name?.trim();
    data.push({
      id,
      object: "model",
      ...(model.owned_by?.trim() ? { owned_by: model.owned_by.trim() } : {}),
      ...(name && name !== id ? { name } : {}),
    });
  }
  if (data.length === 0) {
    throw Object.assign(new Error("model list is empty"), { statusCode: 502 });
  }
  return { object: "list", data };
}

export function toModelList(payload: unknown): ModelList {
  const records = modelRecords(payload);
  return modelList(
    records.flatMap((record) => {
      const id = stringValue(record.id);
      if (!id) {
        return [];
      }
      return [{
        id,
        name: stringValue(record.name),
        owned_by: stringValue(record.owned_by),
      }];
    }),
  );
}

function modelRecords(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.data)) {
    return record.data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
