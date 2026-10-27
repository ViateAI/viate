export type PluginId = string;

export type { Model, ModelList } from "./models.js";
export { modelList, toModelList } from "./models.js";
export type { RequestUsage, UsageParser } from "./usage.js";
export { parseAnthropicUsage, parseOpenAIChatUsage, parseOpenAIResponsesUsage } from "./usage.js";
import type { ModelList } from "./models.js";
import type { UsageParser } from "./usage.js";

export type HttpExchange = {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
  parseUsage?: UsageParser;
  /** Model id actually sent upstream, when it differs from the catalog id. */
  upstreamModel?: string;
};

export type JsonPostRequest = {
  body: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal;
};

export type JsonGetRequest = {
  headers: Record<string, string>;
  signal?: AbortSignal;
};

export type FilePostRequest = {
  contentType: string;
  body: ReadableStream<Uint8Array>;
  headers: Record<string, string>;
  signal?: AbortSignal;
};

export type ProviderConnection = {
  connectionId: string;
  providerId: string;
  credentials: unknown;
};

export type CredentialField = {
  key: string;
  label: string;
  kind: "string" | "secret" | "url";
  required?: boolean;
};

export type CredentialsWrite = {
  credentials: unknown;
  displayLabel?: string;
};

export type KeepaliveInput = {
  connectionId: string;
  credentials: unknown;
  signal: AbortSignal;
  reason: "timer" | "request";
  log: PluginLogger;
};

export type KeepaliveResult = {
  credentials?: unknown;
  displayLabel?: string;
  nextDueMs?: number;
  status: "ok" | "needs_reauth" | "failed";
  error?: string;
};

export type OAuthStartContext = {
  connectionId: string;
  credentials: unknown;
  callbackUrl: string;
};

export type OAuthStartResult =
  | {
      type: "authorization_url";
      authorizationUrl: string;
      session?: unknown;
    }
  | {
      type: "device_code";
      userCode: string;
      verificationUrl: string;
      expiresInMs?: number;
      intervalMs?: number;
      session?: unknown;
    }
  | {
      type: "paste_code";
      session?: unknown;
    };

export type OAuthExchangeInput = {
  connectionId: string;
  credentials: unknown;
  code?: string;
  state?: string;
  session?: unknown;
};

export type OAuthPollInput = {
  connectionId: string;
  credentials: unknown;
  session?: unknown;
};

export type OAuthPollResult =
  | { type: "pending" }
  | { type: "complete"; credentials: unknown; displayLabel?: string }
  | { type: "failed"; error: string };

export type ChatCompletions = {
  chatCompletions(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange>;
};

export type Embeddings = {
  embeddings(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange>;
};

export type Responses = {
  responses(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange>;
};

export type ResponsesCompact = {
  responsesCompact(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange>;
};

export type ImageGenerations = {
  imageGenerations(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange>;
};

export type ImageEdits = {
  imageEdits(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange>;
};

export type Models = {
  listModels(request: JsonGetRequest, connection: ProviderConnection): Promise<ModelList>;
};

export type Keepalive = {
  keepalive(input: KeepaliveInput): Promise<KeepaliveResult>;
};

export type SubscriptionUnit = "currency" | "percent" | "requests" | "tokens";

export type SubscriptionUsage = {
  type: string;
  label: string;
  group?: string;
  unit: SubscriptionUnit;
  currency?: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt?: string;
  unlimited?: boolean;
  reported?: boolean;
};

export type SubscriptionInput = {
  connectionId: string;
  credentials: unknown;
  signal: AbortSignal;
  log: PluginLogger;
};

export type SubscriptionResult = {
  status: "ok" | "needs_reauth" | "failed";
  error?: string;
  plan?: string;
  usages?: SubscriptionUsage[];
  nextDueMs?: number;
};

export type Subscription = {
  subscription(input: SubscriptionInput): Promise<SubscriptionResult>;
};

export type ProviderHandler = {
  id: string;
  credentialsForm?: CredentialField[];
  parseCredentials?(text: string): unknown | Promise<unknown>;
  normalizeCredentials?(input: unknown): CredentialsWrite | Promise<CredentialsWrite>;
  startOAuth?(ctx: OAuthStartContext): Promise<OAuthStartResult>;
  exchangeOAuth?(input: OAuthExchangeInput): Promise<CredentialsWrite>;
  pollOAuth?(input: OAuthPollInput): Promise<OAuthPollResult>;
} & Partial<
  ChatCompletions & Embeddings & Responses & ResponsesCompact & ImageGenerations & ImageEdits & Models & Keepalive & Subscription
>;

export type PluginContext = {
  registerProvider(handler: ProviderHandler): void;
  log: PluginLogger;
};

export type ViatePlugin = {
  id: PluginId;
  register(ctx: PluginContext): void | Promise<void>;
};

export const INBOUND_HEADER_ALLOWLIST = ["anthropic-beta", "anthropic-version", "openai-beta"] as const;

export const OUTBOUND_HEADER_ALLOWLIST = ["content-type", "cache-control"] as const;

export function pickAllowedHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
  allowlist: readonly string[] = INBOUND_HEADER_ALLOWLIST,
): Record<string, string> {
  const allowed: Record<string, true> = {};
  for (const name of allowlist) {
    allowed[name.toLowerCase()] = true;
  }
  const picked: Record<string, string> = {};
  const source: Array<[string, string | undefined]> =
    typeof Headers !== "undefined" && headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers as Record<string, string | string[] | undefined>).map(([name, value]) => [
          name,
          Array.isArray(value) ? value[0] : value,
        ]);
  for (const [name, value] of source) {
    if (!value || !allowed[name.toLowerCase()]) {
      continue;
    }
    picked[name.toLowerCase()] = value;
  }
  return picked;
}

export function definePlugin(plugin: ViatePlugin): ViatePlugin {
  if (!plugin.id?.trim()) {
    throw new Error("plugin id is required");
  }
  if (typeof plugin.register !== "function") {
    throw new Error("plugin register is required");
  }
  return plugin;
}

export type PluginLogFields = Record<string, unknown>;

export type PluginLogger = {
  debug(fields: PluginLogFields, message: string): void;
  debug(message: string): void;
  info(fields: PluginLogFields, message: string): void;
  info(message: string): void;
  warn(fields: PluginLogFields, message: string): void;
  warn(message: string): void;
  error(fields: PluginLogFields, message: string): void;
  error(message: string): void;
  child(fields: PluginLogFields): PluginLogger;
};

export type PluginLogWrite = (
  level: "debug" | "info" | "warn" | "error",
  fields: PluginLogFields | undefined,
  message: string,
) => void;

export function createPluginLogger(
  write: PluginLogWrite,
  bindings: PluginLogFields = {},
): PluginLogger {
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    fieldsOrMessage: PluginLogFields | string,
    message?: string,
  ): void => {
    if (typeof fieldsOrMessage === "string") {
      write(level, Object.keys(bindings).length > 0 ? bindings : undefined, fieldsOrMessage);
      return;
    }
    write(level, { ...bindings, ...fieldsOrMessage }, message ?? "");
  };
  return {
    debug: emit.bind(null, "debug"),
    info: emit.bind(null, "info"),
    warn: emit.bind(null, "warn"),
    error: emit.bind(null, "error"),
    child(fields) {
      return createPluginLogger(write, { ...bindings, ...fields });
    },
  };
}

export function silentPluginLogger(): PluginLogger {
  return createPluginLogger(() => {});
}
