export type AdminPlugin = {
  name: string;
  version: string;
  source: string;
  id: string | null;
  status: "active" | "pending";
  restartRequired: boolean;
  error: string | null;
  capabilities: Array<
    | "chatCompletions"
    | "listModels"
    | "embeddings"
    | "responses"
    | "responsesCompact"
    | "imageGenerations"
    | "imageEdits"
    | "audioTranscriptions"
    | "audioSpeech"
  >;
  credentialsForm: CredentialField[];
  hasParseCredentials: boolean;
  hasOAuth: boolean;
  hasKeepalive: boolean;
  hasSubscription: boolean;
  advertisedEndpointTypes: Array<"openai" | "openai-response" | "openai-image" | "openai-audio">;
};

export type CredentialField = {
  key: string;
  label: string;
  kind: "string" | "secret" | "url";
  required?: boolean;
};

export type OperationLog = {
  id: number;
  action: "add" | "update" | "remove";
  name: string | null;
  source: string | null;
  status: "success" | "failure";
  message: string;
  restartRequired: boolean;
  createdAt: string;
};

export type Connection = {
  id: string;
  providerId: string;
  displayLabel: string;
  hasCredentials: boolean;
  active: boolean;
  keepaliveStatus: "idle" | "ok" | "failed" | "needs_reauth";
  keepaliveError: string | null;
  keepaliveAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubscriptionLevel = "ok" | "low" | "exhausted" | "unknown";

export type SubscriptionUsageView = {
  type: string;
  group: string | null;
  label: string;
  unit: "currency" | "percent" | "requests" | "tokens";
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

export type ConnectionModel = {
  id: string;
  name: string;
  enabled: boolean;
};

export type ConnectionModelCatalog = {
  connectionId: string;
  syncedAt: string | null;
  models: ConnectionModel[];
};

export type AdminPublishedConnection = {
  id: string;
  displayLabel: string;
  modelEnabled: boolean;
  keepaliveStatus: Connection["keepaliveStatus"];
};

export type AdminPublishedProvider = {
  providerId: string;
  rank: number;
  connections: AdminPublishedConnection[];
};

export type AdminPublishedModel = {
  publicId: string;
  ownedBy: string;
  providers: AdminPublishedProvider[];
};

export type OAuthStart =
  | { type: "authorization_url"; authorizationUrl: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUrl: string;
      expiresInMs?: number;
      intervalMs?: number;
    }
  | { type: "paste_code" };

export type ClientApiKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
};

export type ApiError = {
  status: number;
  message: string;
};

let csrfToken: string | null = null;

export function setCsrf(token: string | null): void {
  csrfToken = token;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  const body = method !== "GET" && method !== "HEAD" && init.body === undefined ? "{}" : init.body;
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init.method && init.method !== "GET" && csrfToken) {
    headers.set("x-viate-csrf", csrfToken);
  }
  const response = await fetch(path, {
    ...init,
    body,
    headers,
    credentials: "same-origin",
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && data.error && typeof data.error === "object" && "message" in data.error
        ? String(data.error.message)
        : `request failed (${response.status})`;
    const error: ApiError = { status: response.status, message };
    throw error;
  }
  return data as T;
}

export async function login(password: string): Promise<void> {
  const result = await api<{ csrf: string }>("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  setCsrf(result.csrf);
}

export async function logout(): Promise<void> {
  await api("/api/admin/logout", { method: "POST" });
  setCsrf(null);
}

export async function loadSession(): Promise<boolean> {
  try {
    const result = await api<{ authenticated: boolean; csrf: string }>("/api/admin/session");
    setCsrf(result.csrf);
    return true;
  } catch (error) {
    if (isApiError(error) && error.status === 401) {
      setCsrf(null);
      return false;
    }
    throw error;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return Boolean(error && typeof error === "object" && "status" in error && "message" in error);
}
