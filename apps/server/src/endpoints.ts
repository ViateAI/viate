export const VIATE_PUBLIC_ENDPOINT_TYPES = ["openai", "openai-response"] as const;

export type ProxyEndpointType = (typeof VIATE_PUBLIC_ENDPOINT_TYPES)[number];

const ENDPOINT_TYPE_BY_ID: Record<string, ProxyEndpointType> = {
  openai: "openai",
  "openai-response": "openai-response",
};

export function filterPublicEndpointTypes(values: unknown): ProxyEndpointType[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen: Record<string, true> = {};
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const mapped = ENDPOINT_TYPE_BY_ID[value.trim()];
    if (mapped) {
      seen[mapped] = true;
    }
  }
  return VIATE_PUBLIC_ENDPOINT_TYPES.filter((type) => seen[type]);
}

export function parseAdvertisedEndpointTypes(values: unknown): ProxyEndpointType[] {
  if (!Array.isArray(values)) {
    throw Object.assign(new Error("advertisedEndpointTypes is required"), { statusCode: 400 });
  }
  for (const value of values) {
    if (typeof value !== "string" || !ENDPOINT_TYPE_BY_ID[value.trim()]) {
      throw Object.assign(
        new Error(typeof value === "string" ? `unsupported endpoint type: ${value}` : "advertisedEndpointTypes must be strings"),
        { statusCode: 400 },
      );
    }
  }
  return filterPublicEndpointTypes(values);
}
