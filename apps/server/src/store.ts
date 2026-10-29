import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import {
  parseAdvertisedEndpointTypes,
  VIATE_DEFAULT_ENDPOINT_TYPES,
  VIATE_PUBLIC_ENDPOINT_TYPES,
  type ProxyEndpointType,
} from "./endpoints.js";
import { decryptSecret, encryptSecret, loadOrCreateCredentialKey } from "./crypto.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import {
  applyChannelRatio,
  channelMatchesModel,
  channelProviderLimit,
  formatChannelRatio,
  parseChannelRatio,
  type Channel,
  type ChannelModelRule,
} from "./channels.js";
import { asNano, chargeNano, formatUsd, parseRateUsdToNano, parseUsdToNano, sqlInteger } from "./money.js";

const VIDEO_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type KeepaliveStatus = "idle" | "ok" | "failed" | "needs_reauth";

export type SubscriptionStatus = "unknown" | "ok" | "failed" | "needs_reauth";

export type SubscriptionUnit = "currency" | "percent" | "requests" | "tokens";

export type StoredSubscriptionUsage = {
  connectionId: string;
  type: string;
  position: number;
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
};

export type StoredConnection = {
  id: string;
  providerId: string;
  displayLabel: string;
  hasCredentials: boolean;
  active: boolean;
  keepaliveStatus: KeepaliveStatus;
  keepaliveError: string | null;
  keepaliveAt: string | null;
  subscriptionStatus: SubscriptionStatus;
  subscriptionError: string | null;
  subscriptionAt: string | null;
  subscriptionDueAt: string | null;
  subscriptionPlan: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredModel = {
  id: string;
  name: string;
  enabled: boolean;
  custom: boolean;
  contextLength?: number;
};

export type ConnectionModelCatalog = {
  connectionId: string;
  syncedAt: string | null;
  models: StoredModel[];
};

export type ResolvedConnection = {
  connectionId: string;
  providerId: string;
  credentials: unknown;
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

export type RequestLogEndpoint =
  | "chat.completions"
  | "embeddings"
  | "responses"
  | "responses.compact"
  | "images.generations"
  | "images.edits"
  | "audio.transcriptions"
  | "audio.speech"
  | "videos.generations"
  | "videos.edits"
  | "videos.extensions"
  | "videos.result";

export type RequestLogOutcome =
  | "success"
  | "upstream_error"
  | "client_error"
  | "aborted"
  | "timeout"
  | "auth_error";

export type RequestAttemptRecord = {
  seq: number;
  providerId: string;
  connectionId: string;
  upstreamModel: string | null;
  status: number | null;
  durationMs: number;
  error: string | null;
};

export type RequestLogRecord = {
  id: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  ttfbMs: number | null;
  endpoint: RequestLogEndpoint;
  stream: boolean;
  status: number;
  outcome: RequestLogOutcome;
  requestModel: string | null;
  upstreamModel: string | null;
  providerId: string | null;
  connectionId: string | null;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  userId?: string | null;
  attemptCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  usageSource: "parser" | "missing";
  error: string | null;
  payloadPath: string | null;
  payloadOffset: number | null;
  payloadTruncated: boolean;
};

export type RequestLogStatsWindow = "1m" | "5m" | "1h" | "24h";

export type RequestLogStats = {
  window: RequestLogStatsWindow;
  qps: number;
  tokenTps: number;
  inputTps: number;
  outputTps: number;
  cacheReadTps: number;
  errorRate: number;
  requests: number;
  errors: number;
  aborted: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  series: Array<{ t: number; requests: number; tokens: number }>;
};

export type RequestLogListQuery = {
  from?: string;
  to?: string;
  model?: string;
  connectionId?: string;
  providerId?: string;
  keyId?: string;
  endpoint?: string;
  outcome?: RequestLogOutcome;
  before?: string;
  limit?: number;
};

export type RequestLogPage = {
  requests: RequestLogRecord[];
  nextBefore: string | null;
};

export type RequestLogRangeQuery = {
  from: string;
  to: string;
  model?: string;
  connectionId?: string;
  providerId?: string;
  keyId?: string;
  endpoint?: string;
  outcome?: RequestLogOutcome;
};

export type RequestLogTokenBreakdown = {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type RequestLogRangeStats = {
  from: string;
  to: string;
  requests: number;
  errors: number;
  aborted: number;
  errorRate: number;
  rpm: number;
  tpm: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTpm: number;
  outputTpm: number;
  cacheReadTpm: number;
  cacheWriteTpm: number;
  avgDurationMs: number | null;
  avgTtfbMs: number | null;
  outputTps: number | null;
  series: Array<{ t: string } & RequestLogTokenBreakdown>;
  byModel: Array<{ model: string } & RequestLogTokenBreakdown>;
  byConnection: Array<{ connectionId: string; providerId: string } & RequestLogTokenBreakdown>;
};

export type StoredApiKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  userId: string | null;
  channelId: string | null;
};

export type { Channel, ChannelModelRule };

export type CreatedApiKey = {
  apiKey: StoredApiKey;
  secret: string;
};

export type StoredVideoRequest = {
  requestId: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  userId: string | null;
  apiKeyId: string | null;
  createdAt: string;
};

export type GatewayUser = {
  id: string;
  email: string;
  name: string;
  status: "active" | "disabled";
  balanceUsd: string;
  createdAt: string;
  updatedAt: string;
};

export type LedgerEntry = {
  id: string;
  userId: string;
  deltaUsd: string;
  balanceAfterUsd: string;
  reason: "grant" | "adjust" | "usage";
  requestId: string | null;
  note: string | null;
  createdAt: string;
};

export type UserUsageRequest = {
  id: string;
  startedAt: string;
  endpoint: string;
  requestModel: string | null;
  status: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type UserUsage = {
  user: GatewayUser;
  ledger: LedgerEntry[];
  requests: UserUsageRequest[];
};

export type PublishedMember = {
  connectionId: string;
  providerId: string;
  modelId: string;
  name: string;
  contextLength: number | null;
  displayLabel: string;
  keepaliveStatus: KeepaliveStatus;
  createdAt: string;
  credentials: unknown;
};

export type PublicModelChild = {
  id: string;
  owned_by: string;
};

export type PublicModel = {
  id: string;
  object: "model";
  owned_by: string;
  name?: string;
  supported_endpoint_types: ProxyEndpointType[];
  context_length?: number;
  children?: PublicModelChild[];
};

export type AdminPublishedConnection = {
  id: string;
  displayLabel: string;
  modelEnabled: boolean;
  keepaliveStatus: KeepaliveStatus;
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

type LkgpRecord = {
  modelKey: string;
  providerId: string;
  connectionId: string;
  updatedAt: string;
};

type ConnectionRow = {
  id: string;
  provider_id: string;
  credentials_enc: string | null;
  display_label: string | null;
  active: number;
  keepalive_status: string;
  keepalive_error: string | null;
  keepalive_at: string | null;
  subscription_status: string;
  subscription_error: string | null;
  subscription_at: string | null;
  subscription_due_at: string | null;
  subscription_plan: string | null;
  created_at: string;
  updated_at: string;
};

type LogRow = {
  id: number;
  action: string;
  name: string | null;
  source: string | null;
  status: string;
  message: string;
  restart_required: number;
  created_at: string;
};

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: string;
  user_id: string | null;
  channel_id: string | null;
};

type ChannelRow = {
  id: string;
  name: string;
  ratio_numerator: number | bigint;
  ratio_denominator: number | bigint;
  model_rule: string;
};

type RequestLogRow = {
  id: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  ttfb_ms: number | null;
  endpoint: string;
  stream: number;
  status: number;
  outcome: string;
  request_model: string | null;
  upstream_model: string | null;
  provider_id: string | null;
  connection_id: string | null;
  api_key_id: string | null;
  api_key_prefix: string | null;
  user_id: string | null;
  attempt_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  usage_source: string;
  error: string | null;
  payload_path: string | null;
  payload_offset: number | null;
  payload_truncated: number;
};

type VideoRequestRow = {
  request_id: string;
  connection_id: string;
  provider_id: string;
  model_id: string;
  user_id: string | null;
  api_key_id: string | null;
  created_at: string;
};

type RequestAttemptRow = {
  request_id: string;
  seq: number;
  provider_id: string;
  connection_id: string;
  upstream_model: string | null;
  status: number | null;
  duration_ms: number;
  error: string | null;
};

export class AdminStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  readonly dataDir: string;
  private readonly credentialsListeners = new Set<(connectionId: string) => void>();

  private constructor(db: DatabaseSync, key: Buffer, dataDir: string) {
    this.db = db;
    this.key = key;
    this.dataDir = dataDir;
  }

  static async open(dataDir: string): Promise<AdminStore> {
    await mkdir(dataDir, { recursive: true });
    const key = await loadOrCreateCredentialKey(dataDir);
    const db = new DatabaseSync(join(dataDir, "viate.sqlite"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        credentials_enc TEXT,
        display_label TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        keepalive_status TEXT NOT NULL DEFAULT 'idle',
        keepalive_error TEXT,
        keepalive_at TEXT,
        subscription_status TEXT NOT NULL DEFAULT 'unknown',
        subscription_error TEXT,
        subscription_at TEXT,
        subscription_due_at TEXT,
        subscription_plan TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        name TEXT,
        source TEXT,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        restart_required INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operation_logs_created_at ON operation_logs(created_at DESC);
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connection_models (
        connection_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL,
        context_length INTEGER,
        custom INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (connection_id, model_id),
        FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS published_model_providers (
        model_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        PRIMARY KEY (model_id, provider_id)
      );
      CREATE TABLE IF NOT EXISTS routing_lkgp (
        model_key TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_advertised_endpoints (
        provider_id TEXT PRIMARY KEY,
        endpoint_types TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        ttfb_ms INTEGER,
        endpoint TEXT NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        request_model TEXT,
        upstream_model TEXT,
        provider_id TEXT,
        connection_id TEXT,
        api_key_id TEXT,
        api_key_prefix TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        usage_source TEXT NOT NULL DEFAULT 'missing',
        error TEXT,
        payload_path TEXT,
        payload_offset INTEGER,
        payload_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS request_logs_started_at ON request_logs(started_at DESC);
      CREATE INDEX IF NOT EXISTS request_logs_model_started ON request_logs(request_model, started_at DESC);
      CREATE INDEX IF NOT EXISTS request_logs_connection_started ON request_logs(connection_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS request_attempts (
        request_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        upstream_model TEXT,
        status INTEGER,
        duration_ms INTEGER NOT NULL,
        error TEXT,
        PRIMARY KEY (request_id, seq),
        FOREIGN KEY (request_id) REFERENCES request_logs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS video_requests (
        request_id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        user_id TEXT,
        api_key_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_stats_minute (
        bucket TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        request_model TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        aborted INTEGER NOT NULL DEFAULT 0,
        duration_ms_sum INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, endpoint, request_model, provider_id, connection_id)
      );
    `);
    migrateConnections(db);
    migrateConnectionModels(db);
    migrateSubscription(db);
    migrateUsers(db);
    db.exec("UPDATE users SET inflight = 0");
    return new AdminStore(db, key, dataDir);
  }

  close(): void {
    this.credentialsListeners.clear();
    this.db.close();
  }

  onCredentialsChanged(listener: (connectionId: string) => void): () => void {
    this.credentialsListeners.add(listener);
    return () => {
      this.credentialsListeners.delete(listener);
    };
  }

  private notifyCredentialsChanged(connectionId: string): void {
    for (const listener of this.credentialsListeners) {
      listener(connectionId);
    }
  }

  listConnections(): StoredConnection[] {
    const rows = this.db.prepare("SELECT * FROM connections ORDER BY created_at, id").all() as ConnectionRow[];
    return rows.map((row) => this.toConnection(row));
  }

  getConnection(id: string): StoredConnection | null {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined;
    return row ? this.toConnection(row) : null;
  }

  createConnection(providerId: string): StoredConnection {
    const trimmed = providerId.trim();
    if (!trimmed) {
      throw Object.assign(new Error("providerId is required"), { statusCode: 400 });
    }
    const latest = this.db
      .prepare("SELECT created_at FROM connections ORDER BY created_at DESC, id DESC LIMIT 1")
      .get() as { created_at: string } | undefined;
    let now = new Date().toISOString();
    if (latest && latest.created_at >= now) {
      const next = Date.parse(latest.created_at);
      now = new Date((Number.isNaN(next) ? Date.now() : next) + 1).toISOString();
    }
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO connections (id, provider_id, credentials_enc, display_label, active, keepalive_status, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 0, 'idle', ?, ?)`,
      )
      .run(id, trimmed, now, now);
    const created = this.getConnection(id);
    if (!created) {
      throw new Error("failed to create connection");
    }
    return created;
  }

  putCredentials(id: string, credentials: unknown, displayLabel?: string): StoredConnection {
    const existing = this.requireRow(id);
    const now = new Date().toISOString();
    const enc = encryptSecret(this.key, JSON.stringify(credentials ?? null));
    const label = displayLabel?.trim() || existing.display_label || id;
    this.db
      .prepare(
        `UPDATE connections
         SET credentials_enc = ?, display_label = ?, keepalive_status = 'idle', keepalive_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(enc, label, now, id);
    const updated = this.requireConnection(id);
    this.notifyCredentialsChanged(id);
    return updated;
  }

  clearCredentials(id: string): StoredConnection {
    this.requireRow(id);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE connections
         SET credentials_enc = NULL, display_label = NULL, active = 0, keepalive_status = 'idle', keepalive_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, id);
    const updated = this.requireConnection(id);
    this.notifyCredentialsChanged(id);
    return updated;
  }

  getCredentials(id: string): unknown {
    const row = this.requireRow(id);
    if (!row.credentials_enc) {
      return null;
    }
    return JSON.parse(decryptSecret(this.key, row.credentials_enc)) as unknown;
  }

  setActive(id: string, active: boolean): StoredConnection {
    const existing = this.requireConnection(id);
    if (active) {
      if (!existing.hasCredentials) {
        throw Object.assign(new Error("connection has no credentials"), { statusCode: 400 });
      }
      this.db
        .prepare("UPDATE connections SET active = 1, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    } else {
      this.db.prepare("UPDATE connections SET active = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    }
    return this.requireConnection(id);
  }

  setKeepalive(
    id: string,
    status: KeepaliveStatus,
    error?: string | null,
  ): StoredConnection {
    this.requireRow(id);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE connections SET keepalive_status = ?, keepalive_error = ?, keepalive_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, error ?? null, now, now, id);
    return this.requireConnection(id);
  }

  deleteConnection(id: string): void {
    const result = this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
    if (result.changes === 0) {
      throw Object.assign(new Error("connection not found"), { statusCode: 404 });
    }
    this.notifyCredentialsChanged(id);
  }

  listSubscriptionUsages(): StoredSubscriptionUsage[] {
    const rows = this.db
      .prepare(
        `SELECT connection_id, type, position, group_label, label, unit, currency, used, "limit", remaining, resets_at, unlimited, reported
         FROM connection_usages
         ORDER BY connection_id, position, type`,
      )
      .all() as SubscriptionUsageRow[];
    return rows.map((row) => toSubscriptionUsage(row));
  }

  saveSubscriptionSuccess(
    id: string,
    input: {
      plan: string | null;
      dueAt: string;
      usages: Array<Omit<StoredSubscriptionUsage, "connectionId">>;
    },
  ): void {
    this.requireRow(id);
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE connections
           SET subscription_status = 'ok', subscription_error = NULL, subscription_at = ?, subscription_due_at = ?, subscription_plan = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, input.dueAt, input.plan, now, id);
      this.db.prepare("DELETE FROM connection_usages WHERE connection_id = ?").run(id);
      const insert = this.db.prepare(
        `INSERT INTO connection_usages (
           connection_id, type, position, group_label, label, unit, currency, used, "limit", remaining, resets_at, unlimited, reported
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const usage of input.usages) {
        insert.run(
          id,
          usage.type,
          usage.position,
          usage.group,
          usage.label,
          usage.unit,
          usage.currency,
          usage.used,
          usage.limit,
          usage.remaining,
          usage.resetsAt,
          usage.unlimited ? 1 : 0,
          usage.reported ? 1 : 0,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveSubscriptionFailure(id: string, status: "failed" | "needs_reauth", error: string): void {
    this.requireRow(id);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE connections
         SET subscription_status = ?, subscription_error = ?, subscription_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, error, now, now, id);
  }

  getConnectionModels(id: string): ConnectionModelCatalog {
    this.requireRow(id);
    const rows = this.db
      .prepare(
        `SELECT model_id, name, enabled, synced_at, context_length, custom
         FROM connection_models
         WHERE connection_id = ?
         ORDER BY model_id`,
      )
      .all(id) as Array<{
        model_id: string;
        name: string;
        enabled: number;
        synced_at: string;
        context_length: number | null;
        custom: number;
      }>;
    if (rows.length === 0) {
      return { connectionId: id, syncedAt: null, models: [] };
    }
    let syncedAt: string | null = null;
    for (const row of rows) {
      if (row.custom === 1) {
        continue;
      }
      if (!syncedAt || row.synced_at > syncedAt) {
        syncedAt = row.synced_at;
      }
    }
    return {
      connectionId: id,
      syncedAt,
      models: rows.map((row) => ({
        id: row.model_id,
        name: row.name,
        enabled: row.enabled === 1,
        custom: row.custom === 1,
        ...(typeof row.context_length === "number" ? { contextLength: row.context_length } : {}),
      })),
    };
  }

  replaceConnectionModels(
    id: string,
    models: Array<{ id: string; name?: string; context_length?: number }>,
  ): ConnectionModelCatalog {
    this.requireRow(id);
    const previousRows = this.db
      .prepare(
        `SELECT model_id, name, enabled, synced_at, context_length, custom
         FROM connection_models
         WHERE connection_id = ?`,
      )
      .all(id) as Array<{
        model_id: string;
        name: string;
        enabled: number;
        synced_at: string;
        context_length: number | null;
        custom: number;
      }>;
    const previous = new Map(previousRows.map((row) => [row.model_id, row]));
    const seen = new Set<string>();
    const next: Array<{
      id: string;
      name: string;
      enabled: boolean;
      custom: boolean;
      syncedAt: string;
      contextLength?: number;
    }> = [];
    const syncedAt = new Date().toISOString();
    for (const model of models) {
      const modelId = model.id.trim();
      if (!modelId || seen.has(modelId)) {
        continue;
      }
      seen.add(modelId);
      const prior = previous.get(modelId);
      const context =
        typeof model.context_length === "number" && Number.isFinite(model.context_length) && model.context_length > 0
          ? Math.trunc(model.context_length)
          : undefined;
      next.push({
        id: modelId,
        name: model.name?.trim() || modelId,
        enabled: prior ? prior.enabled === 1 : true,
        custom: false,
        syncedAt,
        ...(context ? { contextLength: context } : {}),
      });
    }
    for (const row of previousRows) {
      if (row.custom !== 1 || seen.has(row.model_id)) {
        continue;
      }
      next.push({
        id: row.model_id,
        name: row.name,
        enabled: row.enabled === 1,
        custom: true,
        syncedAt: row.synced_at,
        ...(typeof row.context_length === "number" ? { contextLength: row.context_length } : {}),
      });
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM connection_models WHERE connection_id = ?").run(id);
      const insert = this.db.prepare(
        `INSERT INTO connection_models (connection_id, model_id, name, enabled, synced_at, context_length, custom)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const model of next) {
        insert.run(
          id,
          model.id,
          model.name,
          model.enabled ? 1 : 0,
          model.syncedAt,
          model.contextLength ?? null,
          model.custom ? 1 : 0,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getConnectionModels(id);
  }

  addConnectionModel(id: string, input: { id: string; name?: string }): ConnectionModelCatalog {
    this.requireRow(id);
    const modelId = input.id.trim();
    if (!modelId) {
      throw Object.assign(new Error("model id is required"), { statusCode: 400 });
    }
    const name = input.name?.trim() || modelId;
    try {
      this.db
        .prepare(
          `INSERT INTO connection_models (connection_id, model_id, name, enabled, synced_at, context_length, custom)
           VALUES (?, ?, ?, 1, ?, NULL, 1)`,
        )
        .run(id, modelId, name, new Date().toISOString());
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw Object.assign(new Error("model already exists"), { statusCode: 409 });
      }
      throw error;
    }
    return this.getConnectionModels(id);
  }

  deleteConnectionModel(id: string, modelId: string): ConnectionModelCatalog {
    this.requireRow(id);
    const row = this.db
      .prepare("SELECT custom FROM connection_models WHERE connection_id = ? AND model_id = ?")
      .get(id, modelId) as { custom: number } | undefined;
    if (!row) {
      throw Object.assign(new Error("model not found"), { statusCode: 404 });
    }
    if (row.custom !== 1) {
      throw Object.assign(new Error("synced model cannot be removed"), { statusCode: 400 });
    }
    this.db.prepare("DELETE FROM connection_models WHERE connection_id = ? AND model_id = ?").run(id, modelId);
    return this.getConnectionModels(id);
  }

  setConnectionModelEnabled(id: string, modelId: string, enabled: boolean): ConnectionModelCatalog {
    this.requireRow(id);
    const result = this.db
      .prepare("UPDATE connection_models SET enabled = ? WHERE connection_id = ? AND model_id = ?")
      .run(enabled ? 1 : 0, id, modelId);
    if (result.changes === 0) {
      throw Object.assign(new Error("model not found"), { statusCode: 404 });
    }
    return this.getConnectionModels(id);
  }

  listPublishedMembers(filter?: { modelId?: string; providerId?: string }): PublishedMember[] {
    const clauses = [
      "c.active = 1",
      "c.credentials_enc IS NOT NULL",
      "c.keepalive_status != 'needs_reauth'",
      "cm.enabled = 1",
    ];
    const params: string[] = [];
    if (filter?.modelId) {
      clauses.push("cm.model_id = ?");
      params.push(filter.modelId);
    }
    if (filter?.providerId) {
      clauses.push("c.provider_id = ?");
      params.push(filter.providerId);
    }
    const rows = this.db
      .prepare(
        `SELECT c.id AS connection_id, c.provider_id, c.display_label, c.keepalive_status,
                c.credentials_enc, c.created_at, cm.model_id, cm.name, cm.context_length
         FROM connection_models cm
         INNER JOIN connections c ON c.id = cm.connection_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY c.created_at, c.id, cm.model_id`,
      )
      .all(...params) as Array<{
      connection_id: string;
      provider_id: string;
      display_label: string | null;
      keepalive_status: string;
      credentials_enc: string;
      created_at: string;
      model_id: string;
      name: string;
      context_length: number | null;
    }>;
    return rows.map((row) => ({
      connectionId: row.connection_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      name: row.name,
      contextLength: typeof row.context_length === "number" ? row.context_length : null,
      displayLabel: row.display_label?.trim() || row.connection_id,
      keepaliveStatus: (row.keepalive_status as KeepaliveStatus) || "idle",
      createdAt: row.created_at,
      credentials: JSON.parse(decryptSecret(this.key, row.credentials_enc)) as unknown,
    }));
  }

  listPublicCatalog(providerIds?: readonly string[] | null): { object: "list"; data: PublicModel[] } {
    let members = this.listPublishedMembers();
    if (providerIds) {
      const allowed = new Set(providerIds);
      members = members.filter((member) => allowed.has(member.providerId));
    }
    const grouped = this.groupPublishedMembers(members);
    const data: PublicModel[] = [];
    for (const modelId of [...grouped.keys()].sort()) {
      data.push(this.toPublicModel(modelId, grouped.get(modelId) ?? []));
    }
    return { object: "list", data };
  }

  listChannels(): Channel[] {
    const rows = this.db.prepare("SELECT * FROM channels ORDER BY id").all() as ChannelRow[];
    return rows.map((row) => toChannel(row));
  }

  getChannel(id: string): Channel | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
    return row ? toChannel(row) : null;
  }

  listUserChannelIds(userId: string): string[] {
    this.requireUser(userId);
    const rows = this.db
      .prepare("SELECT channel_id FROM user_channels WHERE user_id = ? ORDER BY channel_id")
      .all(userId) as Array<{ channel_id: string }>;
    return rows.map((row) => row.channel_id);
  }

  userHasChannel(userId: string, channelId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM user_channels WHERE user_id = ? AND channel_id = ?")
      .get(userId, channelId) as { ok: number } | undefined;
    return Boolean(row);
  }

  setUserChannels(userId: string, channelIds: string[]): string[] {
    this.requireUser(userId);
    if (!Array.isArray(channelIds)) {
      throw Object.assign(new Error("channelIds is required"), { statusCode: 400 });
    }
    const known = new Set(this.listChannels().map((channel) => channel.id));
    const unique: string[] = [];
    const seen: Record<string, true> = {};
    for (const channelId of channelIds) {
      if (typeof channelId !== "string") {
        throw Object.assign(new Error("unknown channel"), { statusCode: 400 });
      }
      const trimmed = channelId.trim();
      if (!trimmed || !known.has(trimmed)) {
        throw Object.assign(new Error("unknown channel"), { statusCode: 400 });
      }
      if (seen[trimmed]) {
        continue;
      }
      seen[trimmed] = true;
      unique.push(trimmed);
    }
    unique.sort();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM user_channels WHERE user_id = ?").run(userId);
      const insert = this.db.prepare("INSERT INTO user_channels (user_id, channel_id) VALUES (?, ?)");
      for (const channelId of unique) {
        insert.run(userId, channelId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return unique;
  }

  listChannelCatalog(channel: Channel): { object: "list"; data: PublicModel[] } {
    const catalog = this.listPublicCatalog(channelProviderLimit(channel.rule));
    return {
      object: "list",
      data: catalog.data.filter((model) =>
        channelMatchesModel(
          channel.rule,
          {
            id: model.id,
            providerIds: model.owned_by === "viate" ? [] : [model.owned_by],
            endpointTypes: model.supported_endpoint_types,
          },
          null,
        ),
      ),
    };
  }

  createChannel(input: { name: string; ratio: string; rule: ChannelModelRule }): Channel {
    const name = input.name.trim();
    if (!name) {
      throw Object.assign(new Error("name is required"), { statusCode: 400 });
    }
    const ratio = parseChannelRatio(input.ratio);
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO channels (id, name, ratio_numerator, ratio_denominator, model_rule)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, name, ratio.numerator, ratio.denominator, JSON.stringify(input.rule));
    return this.requireChannel(id);
  }

  updateChannel(id: string, input: { name: string; ratio: string; rule: ChannelModelRule }): Channel {
    this.requireChannel(id);
    const name = input.name.trim();
    if (!name) {
      throw Object.assign(new Error("name is required"), { statusCode: 400 });
    }
    const ratio = parseChannelRatio(input.ratio);
    this.db
      .prepare(
        `UPDATE channels
         SET name = ?, ratio_numerator = ?, ratio_denominator = ?, model_rule = ?
         WHERE id = ?`,
      )
      .run(name, ratio.numerator, ratio.denominator, JSON.stringify(input.rule), id);
    return this.requireChannel(id);
  }

  deleteChannel(id: string): void {
    this.requireChannel(id);
    const keys = this.db.prepare("SELECT 1 AS ok FROM api_keys WHERE channel_id = ? LIMIT 1").get(id) as
      | { ok: number }
      | undefined;
    const grants = this.db.prepare("SELECT 1 AS ok FROM user_channels WHERE channel_id = ? LIMIT 1").get(id) as
      | { ok: number }
      | undefined;
    if (keys || grants) {
      throw Object.assign(new Error("channel in use"), { statusCode: 409 });
    }
    this.db.prepare("DELETE FROM channels WHERE id = ?").run(id);
  }

  channelView(channel: Channel): { id: string; name: string; ratio: string; rule: ChannelModelRule } {
    return {
      id: channel.id,
      name: channel.name,
      ratio: formatChannelRatio(channel.ratioNumerator, channel.ratioDenominator),
      rule: channel.rule,
    };
  }

  listConnectionProviderIds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT provider_id FROM connections ORDER BY provider_id")
      .all() as Array<{ provider_id: string }>;
    return rows.map((row) => row.provider_id);
  }

  getAdvertisedEndpointTypes(providerId: string): ProxyEndpointType[] {
    const id = providerId.trim();
    if (!id) {
      return [...VIATE_DEFAULT_ENDPOINT_TYPES];
    }
    const row = this.db
      .prepare("SELECT endpoint_types FROM provider_advertised_endpoints WHERE provider_id = ?")
      .get(id) as { endpoint_types: string } | undefined;
    if (!row) {
      return [...VIATE_DEFAULT_ENDPOINT_TYPES];
    }
    try {
      return parseAdvertisedEndpointTypes(JSON.parse(row.endpoint_types) as unknown);
    } catch {
      return [...VIATE_DEFAULT_ENDPOINT_TYPES];
    }
  }

  setAdvertisedEndpointTypes(providerId: string, types: unknown): ProxyEndpointType[] {
    const id = providerId.trim();
    if (!id) {
      throw Object.assign(new Error("providerId is required"), { statusCode: 400 });
    }
    const advertised = parseAdvertisedEndpointTypes(types);
    this.db
      .prepare(
        `INSERT INTO provider_advertised_endpoints (provider_id, endpoint_types, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET endpoint_types = excluded.endpoint_types, updated_at = excluded.updated_at`,
      )
      .run(id, JSON.stringify(advertised), new Date().toISOString());
    return advertised;
  }

  listAdminPublishedModels(): AdminPublishedModel[] {
    const grouped = this.groupPublishedMembers(this.listPublishedMembers());
    const inventory = this.db
      .prepare(
        `SELECT c.id, c.provider_id, c.display_label, c.keepalive_status, c.created_at,
                cm.model_id, cm.enabled
         FROM connection_models cm
         INNER JOIN connections c ON c.id = cm.connection_id
         WHERE c.active = 1 AND c.credentials_enc IS NOT NULL
         ORDER BY c.created_at, c.id`,
      )
      .all() as Array<{
      id: string;
      provider_id: string;
      display_label: string | null;
      keepalive_status: string;
      created_at: string;
      model_id: string;
      enabled: number;
    }>;
    const models: AdminPublishedModel[] = [];
    for (const modelId of [...grouped.keys()].sort()) {
      const members = grouped.get(modelId) ?? [];
      const providerIds = this.providerOrder(modelId, members);
      this.prunePublishedModelProviders(modelId, providerIds);
      const providers: AdminPublishedProvider[] = providerIds.map((providerId, rank) => ({
        providerId,
        rank,
        connections: inventory
          .filter((row) => row.model_id === modelId && row.provider_id === providerId)
          .map((row) => ({
            id: row.id,
            displayLabel: row.display_label?.trim() || row.id,
            modelEnabled: row.enabled === 1,
            keepaliveStatus: (row.keepalive_status as KeepaliveStatus) || "idle",
          })),
      }));
      const uniqueProviders = new Set(members.map((member) => member.providerId));
      models.push({
        publicId: modelId,
        ownedBy: uniqueProviders.size === 1 ? [...uniqueProviders][0]! : "viate",
        providers,
      });
    }
    return models;
  }

  setPublishedModelProviders(modelId: string, providerIds: string[]): AdminPublishedModel[] {
    const members = this.listPublishedMembers({ modelId });
    const contributing = this.providerOrder(modelId, members);
    if (contributing.length === 0) {
      throw Object.assign(new Error("model is not published"), { statusCode: 404 });
    }
    if (!isPermutation(providerIds, contributing)) {
      throw Object.assign(new Error("providerIds must be a permutation of contributing providers"), {
        statusCode: 400,
      });
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM published_model_providers WHERE model_id = ?").run(modelId);
      const insert = this.db.prepare(
        "INSERT INTO published_model_providers (model_id, provider_id, rank) VALUES (?, ?, ?)",
      );
      providerIds.forEach((providerId, rank) => {
        insert.run(modelId, providerId, rank);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listAdminPublishedModels();
  }

  orderMembers(members: PublishedMember[]): PublishedMember[] {
    if (members.length <= 1) {
      return members.slice();
    }
    const byModel = this.groupPublishedMembers(members);
    const ordered: PublishedMember[] = [];
    for (const modelId of byModel.keys()) {
      const group = byModel.get(modelId) ?? [];
      const ranks = new Map(this.providerOrder(modelId, group).map((providerId, rank) => [providerId, rank]));
      ordered.push(
        ...group.slice().sort((a, b) => {
          const rankDelta = (ranks.get(a.providerId) ?? 0) - (ranks.get(b.providerId) ?? 0);
          if (rankDelta !== 0) {
            return rankDelta;
          }
          if (a.createdAt !== b.createdAt) {
            return a.createdAt < b.createdAt ? -1 : 1;
          }
          return a.connectionId < b.connectionId ? -1 : 1;
        }),
      );
    }
    return ordered;
  }

  getLkgp(modelKey: string): LkgpRecord | null {
    const row = this.db
      .prepare("SELECT model_key, provider_id, connection_id, updated_at FROM routing_lkgp WHERE model_key = ?")
      .get(modelKey) as
      | { model_key: string; provider_id: string; connection_id: string; updated_at: string }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      modelKey: row.model_key,
      providerId: row.provider_id,
      connectionId: row.connection_id,
      updatedAt: row.updated_at,
    };
  }

  setLkgp(modelKey: string, providerId: string, connectionId: string): void {
    this.db
      .prepare(
        `INSERT INTO routing_lkgp (model_key, provider_id, connection_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(model_key) DO UPDATE SET
           provider_id = excluded.provider_id,
           connection_id = excluded.connection_id,
           updated_at = excluded.updated_at`,
      )
      .run(modelKey, providerId, connectionId, new Date().toISOString());
  }

  private groupPublishedMembers(members: PublishedMember[]): Map<string, PublishedMember[]> {
    const grouped = new Map<string, PublishedMember[]>();
    for (const member of members) {
      const modelId = member.modelId.trim();
      if (!modelId) {
        continue;
      }
      const list = grouped.get(modelId);
      if (list) {
        list.push(member);
      } else {
        grouped.set(modelId, [member]);
      }
    }
    return grouped;
  }

  private advertisedEndpointTypesFor(providerIds: string[]): ProxyEndpointType[] {
    const seen: Record<string, true> = {};
    for (const providerId of providerIds) {
      for (const type of this.getAdvertisedEndpointTypes(providerId)) {
        seen[type] = true;
      }
    }
    return VIATE_PUBLIC_ENDPOINT_TYPES.filter((type) => seen[type]);
  }

  private toPublicModel(modelId: string, members: PublishedMember[]): PublicModel {
    const providerIds = this.providerOrder(modelId, members);
    this.prunePublishedModelProviders(modelId, providerIds);
    const name = members.map((member) => member.name.trim()).find((value) => value && value !== modelId);
    let contextLength: number | undefined;
    for (const member of members) {
      if (typeof member.contextLength === "number" && (contextLength === undefined || member.contextLength > contextLength)) {
        contextLength = member.contextLength;
      }
    }
    const proxyFields = {
      supported_endpoint_types: this.advertisedEndpointTypesFor(providerIds),
      ...(name ? { name } : {}),
      ...(contextLength ? { context_length: contextLength } : {}),
    };
    if (providerIds.length <= 1) {
      return {
        id: modelId,
        object: "model",
        owned_by: providerIds[0] ?? "viate",
        ...proxyFields,
      };
    }
    return {
      id: modelId,
      object: "model",
      owned_by: "viate",
      ...proxyFields,
      children: providerIds.map((providerId) => ({
        id: `${providerId}/${modelId}`,
        owned_by: providerId,
      })),
    };
  }

  private providerOrder(modelId: string, members: PublishedMember[]): string[] {
    const firstSeen: string[] = [];
    const seen: Record<string, true> = {};
    for (const member of members) {
      if (seen[member.providerId]) {
        continue;
      }
      seen[member.providerId] = true;
      firstSeen.push(member.providerId);
    }
    const stored = (
      this.db
        .prepare(
          "SELECT provider_id FROM published_model_providers WHERE model_id = ? ORDER BY rank ASC, provider_id ASC",
        )
        .all(modelId) as Array<{ provider_id: string }>
    )
      .map((row) => row.provider_id)
      .filter((providerId) => seen[providerId]);
    const storedSet: Record<string, true> = {};
    for (const providerId of stored) {
      storedSet[providerId] = true;
    }
    return [...stored, ...firstSeen.filter((providerId) => !storedSet[providerId])];
  }

  private prunePublishedModelProviders(modelId: string, contributing: string[]): void {
    const keep: Record<string, true> = {};
    for (const providerId of contributing) {
      keep[providerId] = true;
    }
    const rows = this.db
      .prepare("SELECT provider_id FROM published_model_providers WHERE model_id = ?")
      .all(modelId) as Array<{ provider_id: string }>;
    for (const row of rows) {
      if (!keep[row.provider_id]) {
        this.db
          .prepare("DELETE FROM published_model_providers WHERE model_id = ? AND provider_id = ?")
          .run(modelId, row.provider_id);
      }
    }
  }

  resolveActiveConnection(): ResolvedConnection | null {
    const row = this.db.prepare("SELECT * FROM connections WHERE active = 1 LIMIT 1").get() as ConnectionRow | undefined;
    if (!row) {
      return null;
    }
    return this.toResolved(row);
  }

  listResolvedConnections(): ResolvedConnection[] {
    const rows = this.db.prepare("SELECT * FROM connections").all() as ConnectionRow[];
    return rows.filter((row) => row.credentials_enc).map((row) => this.toResolved(row));
  }

  listApiKeys(userId?: string): StoredApiKey[] {
    const rows = (
      userId === undefined
        ? this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC, id").all()
        : this.db.prepare("SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC, id").all(userId)
    ) as ApiKeyRow[];
    return rows.map((row) => this.toApiKey(row));
  }

  createApiKey(name: string, userId?: string | null, channelId?: string | null): CreatedApiKey {
    const trimmed = name.trim();
    if (!trimmed) {
      throw Object.assign(new Error("name is required"), { statusCode: 400 });
    }
    const ownerId = userId ?? null;
    if (ownerId && !this.db.prepare("SELECT id FROM users WHERE id = ?").get(ownerId)) {
      throw Object.assign(new Error("user not found"), { statusCode: 404 });
    }
    const requested = typeof channelId === "string" ? channelId.trim() : "";
    const boundChannel = requested || null;
    if (boundChannel && !this.getChannel(boundChannel)) {
      throw Object.assign(new Error("unknown channel"), { statusCode: 400 });
    }
    if (boundChannel && ownerId && !this.userHasChannel(ownerId, boundChannel)) {
      throw Object.assign(new Error("channel not available"), { statusCode: 400 });
    }
    const secret = `viate_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const prefix = secret.slice(0, 12);
    this.db
      .prepare(
        "INSERT INTO api_keys (id, name, prefix, key_hash, created_at, user_id, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        trimmed,
        prefix,
        createHmac("sha256", this.key).update(secret).digest("hex"),
        createdAt,
        ownerId,
        boundChannel,
      );
    return {
      apiKey: { id, name: trimmed, prefix, createdAt, userId: ownerId, channelId: boundChannel },
      secret,
    };
  }

  verifyApiKey(secret: string | undefined): StoredApiKey | null {
    if (!secret) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(createHmac("sha256", this.key).update(secret).digest("hex")) as
      | ApiKeyRow
      | undefined;
    return row ? this.toApiKey(row) : null;
  }

  deleteApiKey(id: string): void {
    const result = this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
    if (result.changes === 0) {
      throw Object.assign(new Error("api key not found"), { statusCode: 404 });
    }
  }

  saveVideoRequest(input: {
    requestId: string;
    connectionId: string;
    providerId: string;
    modelId: string;
    userId: string | null;
    apiKeyId: string | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare("DELETE FROM video_requests WHERE created_at < ?")
      .run(new Date(now - VIDEO_REQUEST_TTL_MS).toISOString());
    this.db
      .prepare(
        `INSERT INTO video_requests (request_id, connection_id, provider_id, model_id, user_id, api_key_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           connection_id = excluded.connection_id,
           provider_id = excluded.provider_id,
           model_id = excluded.model_id,
           user_id = excluded.user_id,
           api_key_id = excluded.api_key_id,
           created_at = excluded.created_at`,
      )
      .run(
        input.requestId,
        input.connectionId,
        input.providerId,
        input.modelId,
        input.userId,
        input.apiKeyId,
        new Date(now).toISOString(),
      );
  }

  getVideoRequest(requestId: string): StoredVideoRequest | null {
    const row = this.db.prepare("SELECT * FROM video_requests WHERE request_id = ?").get(requestId) as
      | VideoRequestRow
      | undefined;
    if (!row) {
      return null;
    }
    return {
      requestId: row.request_id,
      connectionId: row.connection_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      userId: row.user_id,
      apiKeyId: row.api_key_id,
      createdAt: row.created_at,
    };
  }

  createUser(input: { email: string; name: string; password: string }): GatewayUser {
    const email = normalizeEmail(input.email);
    const name = normalizeName(input.name);
    const password = normalizePassword(input.password);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO users (
            id, email, name, password_hash, status, balance_nano, inflight, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', 0, 0, ?, ?)`,
        )
        .run(id, email, name, hashPassword(password), now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw Object.assign(new Error("email already exists"), { statusCode: 409 });
      }
      throw error;
    }
    return this.requireUser(id);
  }

  listUsers(): GatewayUser[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at DESC, id DESC").all() as UserRow[];
    return rows.map((row) => this.toUser(row));
  }

  getUser(id: string): GatewayUser | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? this.toUser(row) : null;
  }

  updateUser(id: string, patch: { name?: string; status?: string; password?: string }): GatewayUser {
    const row = this.requireUserRow(id);
    const name = patch.name === undefined ? row.name : normalizeName(patch.name);
    let status = row.status;
    if (patch.status !== undefined) {
      if (patch.status !== "active" && patch.status !== "disabled") {
        throw Object.assign(new Error("invalid status"), { statusCode: 400 });
      }
      status = patch.status;
    }
    const now = new Date().toISOString();
    if (patch.password !== undefined) {
      this.db
        .prepare("UPDATE users SET name = ?, status = ?, password_hash = ?, updated_at = ? WHERE id = ?")
        .run(name, status, hashPassword(normalizePassword(patch.password)), now, id);
    } else {
      this.db.prepare("UPDATE users SET name = ?, status = ?, updated_at = ? WHERE id = ?").run(name, status, now, id);
    }
    return this.requireUser(id);
  }

  authenticateUser(email: string, password: string): GatewayUser {
    const canonical = canonicalEmail(email);
    const row = canonical
      ? (this.db.prepare("SELECT * FROM users WHERE email = ?").get(canonical) as UserRow | undefined)
      : undefined;
    const matches = verifyPassword(password, row?.password_hash ?? null);
    if (!row || !matches) {
      throw Object.assign(new Error("invalid email or password"), { statusCode: 401 });
    }
    if (row.status !== "active") {
      throw Object.assign(new Error("user disabled"), { statusCode: 403 });
    }
    return this.toUser(row);
  }

  changeUserPassword(id: string, currentPassword: string, newPassword: string): void {
    const row = this.requireUserRow(id);
    if (!verifyPassword(currentPassword, row.password_hash)) {
      throw Object.assign(new Error("invalid password"), { statusCode: 401 });
    }
    const next = normalizePassword(newPassword);
    this.db
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(hashPassword(next), new Date().toISOString(), id);
  }

  grantUsd(userId: string, usd: string, note?: string | null): { user: GatewayUser; entry: LedgerEntry } {
    const delta = parseUsdToNano(usd);
    const cleanNote = cleanLedgerNote(note);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
      if (!row) {
        throw Object.assign(new Error("user not found"), { statusCode: 404 });
      }
      const balance = asNano(row.balance_nano);
      const balanceAfter = balance + delta;
      if (delta < 0n && balanceAfter < 0n) {
        throw Object.assign(new Error("balance cannot be negative"), { statusCode: 400 });
      }
      const now = new Date().toISOString();
      const reason = delta > 0n ? "grant" : "adjust";
      const id = crypto.randomUUID();
      this.db
        .prepare("UPDATE users SET balance_nano = ?, updated_at = ? WHERE id = ?")
        .run(sqlInteger(balanceAfter), now, userId);
      this.db
        .prepare(
          `INSERT INTO token_ledger (id, user_id, delta, balance_after, reason, request_id, note, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, userId, sqlInteger(delta), sqlInteger(balanceAfter), reason, cleanNote, now);
      this.db.exec("COMMIT");
      return {
        user: this.toUser({ ...row, balance_nano: sqlInteger(balanceAfter), updated_at: now }),
        entry: {
          id,
          userId,
          deltaUsd: formatUsd(delta),
          balanceAfterUsd: formatUsd(balanceAfter),
          reason,
          requestId: null,
          note: cleanNote,
          createdAt: now,
        },
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listLedger(userId: string, limit = 50): LedgerEntry[] {
    this.requireUser(userId);
    const rows = this.db
      .prepare("SELECT * FROM token_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(userId, limit) as LedgerRow[];
    return rows.map((row) => this.toLedger(row));
  }

  assertUserActive(userId: string): void {
    const row = this.db.prepare("SELECT status FROM users WHERE id = ?").get(userId) as { status: string } | undefined;
    if (!row) {
      throw Object.assign(new Error("user not found"), { statusCode: 404 });
    }
    if (row.status !== "active") {
      throw Object.assign(new Error("user disabled"), { statusCode: 403 });
    }
  }

  admitUser(userId: string): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE users SET inflight = inflight + 1, updated_at = ?
         WHERE id = ? AND status = 'active' AND balance_nano > 0 AND inflight < 8`,
      )
      .run(now, userId);
    if (Number(result.changes) !== 0) {
      return;
    }
    const row = this.db.prepare("SELECT status FROM users WHERE id = ?").get(userId) as { status: string } | undefined;
    if (!row) {
      throw Object.assign(new Error("user not found"), { statusCode: 404 });
    }
    if (row.status !== "active") {
      throw Object.assign(new Error("user disabled"), { statusCode: 403 });
    }
    throw Object.assign(new Error("insufficient balance"), { statusCode: 402 });
  }

  settleUsage(input: {
    userId: string;
    requestId: string;
    inputTokens: number;
    outputTokens: number;
    inputNanoPerMillion: number;
    outputNanoPerMillion: number;
    perRequestNano?: number;
    ratioNumerator?: number;
    ratioDenominator?: number;
  }): void {
    const base =
      chargeNano(input.inputTokens, input.inputNanoPerMillion) +
      chargeNano(input.outputTokens, input.outputNanoPerMillion) +
      asNano(input.perRequestNano);
    const charge = applyChannelRatio(base, input.ratioNumerator ?? 1, input.ratioDenominator ?? 1);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO user_usage_settlements (request_id, user_id, tokens, created_at) VALUES (?, ?, ?, ?)")
        .run(input.requestId, input.userId, sqlInteger(charge), now);
      if (Number(inserted.changes) === 0) {
        this.db.exec("COMMIT");
        return;
      }
      this.db
        .prepare(
          `UPDATE users
           SET inflight = CASE WHEN inflight > 0 THEN inflight - 1 ELSE 0 END,
               balance_nano = balance_nano - ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(sqlInteger(charge), now, input.userId);
      if (charge > 0n) {
        const row = this.db.prepare("SELECT balance_nano FROM users WHERE id = ?").get(input.userId) as
          | { balance_nano: number | bigint }
          | undefined;
        if (row) {
          this.db
            .prepare(
              `INSERT INTO token_ledger (id, user_id, delta, balance_after, reason, request_id, note, created_at)
               VALUES (?, ?, ?, ?, 'usage', ?, NULL, ?)`,
            )
            .run(
              crypto.randomUUID(),
              input.userId,
              sqlInteger(-charge),
              sqlInteger(asNano(row.balance_nano)),
              input.requestId,
              now,
            );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceModelPrices(
    rows: Array<{ modelId: string; inputNanoPerMillion: number; outputNanoPerMillion: number }>,
    fetchedAt: string,
    source = "https://models.dev/api.json",
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM model_prices").run();
      const insert = this.db.prepare(
        `INSERT INTO model_prices (model_id, input_nano_per_million, output_nano_per_million, updated_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(row.modelId, row.inputNanoPerMillion, row.outputNanoPerMillion, fetchedAt);
      }
      this.db
        .prepare(
          `INSERT INTO model_price_meta (id, source, fetched_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET source = excluded.source, fetched_at = excluded.fetched_at`,
        )
        .run(source, fetchedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listModelPrices(): {
    fetchedAt: string | null;
    rows: Array<{ modelId: string; inputNanoPerMillion: number; outputNanoPerMillion: number }>;
  } {
    const meta = this.db.prepare("SELECT fetched_at FROM model_price_meta WHERE id = 1").get() as
      | { fetched_at: string }
      | undefined;
    const rows = this.db
      .prepare("SELECT model_id, input_nano_per_million, output_nano_per_million FROM model_prices")
      .all() as Array<{
      model_id: string;
      input_nano_per_million: number | bigint;
      output_nano_per_million: number | bigint;
    }>;
    return {
      fetchedAt: meta?.fetched_at ?? null,
      rows: rows.map((row) => ({
        modelId: row.model_id,
        inputNanoPerMillion: numberFrom(row.input_nano_per_million),
        outputNanoPerMillion: numberFrom(row.output_nano_per_million),
      })),
    };
  }

  listModelPriceOverrides(): Array<{
    modelId: string;
    inputNanoPerMillion: number;
    outputNanoPerMillion: number;
    perRequestNano: number | null;
    updatedAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT model_id, input_nano_per_million, output_nano_per_million, per_request_nano, updated_at
         FROM model_price_overrides ORDER BY model_id`,
      )
      .all() as Array<{
      model_id: string;
      input_nano_per_million: number | bigint;
      output_nano_per_million: number | bigint;
      per_request_nano: number | bigint | null;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      modelId: row.model_id,
      inputNanoPerMillion: numberFrom(row.input_nano_per_million),
      outputNanoPerMillion: numberFrom(row.output_nano_per_million),
      perRequestNano: row.per_request_nano == null ? null : numberFrom(row.per_request_nano),
      updatedAt: row.updated_at,
    }));
  }

  getModelPriceOverride(modelId: string): {
    inputNanoPerMillion: number;
    outputNanoPerMillion: number;
    perRequestNano?: number;
  } | null {
    const row = this.db
      .prepare(
        `SELECT input_nano_per_million, output_nano_per_million, per_request_nano
         FROM model_price_overrides WHERE model_id = ?`,
      )
      .get(modelId) as
      | {
          input_nano_per_million: number | bigint;
          output_nano_per_million: number | bigint;
          per_request_nano: number | bigint | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    if (row.per_request_nano != null) {
      return {
        inputNanoPerMillion: 0,
        outputNanoPerMillion: 0,
        perRequestNano: numberFrom(row.per_request_nano),
      };
    }
    return {
      inputNanoPerMillion: numberFrom(row.input_nano_per_million),
      outputNanoPerMillion: numberFrom(row.output_nano_per_million),
    };
  }

  setModelPriceOverride(
    modelId: string,
    inputUsdPerMillion: string,
    outputUsdPerMillion: string,
    usdPerRequest?: string | null,
  ): void {
    const id = modelId.trim();
    if (!id || id.length > 200 || /\s/.test(id)) {
      throw Object.assign(new Error("model id is invalid"), { statusCode: 400 });
    }
    const perRequest = usdPerRequest?.trim() ? parseRateUsdToNano(usdPerRequest) : null;
    const input = perRequest == null ? parseRateUsdToNano(inputUsdPerMillion) : 0n;
    const output = perRequest == null ? parseRateUsdToNano(outputUsdPerMillion) : 0n;
    this.db
      .prepare(
        `INSERT INTO model_price_overrides (
           model_id, input_nano_per_million, output_nano_per_million, per_request_nano, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           input_nano_per_million = excluded.input_nano_per_million,
           output_nano_per_million = excluded.output_nano_per_million,
           per_request_nano = excluded.per_request_nano,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        sqlInteger(input),
        sqlInteger(output),
        perRequest == null ? null : sqlInteger(perRequest),
        new Date().toISOString(),
      );
  }

  deleteModelPriceOverride(modelId: string): void {
    const result = this.db.prepare("DELETE FROM model_price_overrides WHERE model_id = ?").run(modelId);
    if (Number(result.changes) === 0) {
      throw Object.assign(new Error("model price not found"), { statusCode: 404 });
    }
  }

  usageForUser(userId: string): UserUsage {
    const user = this.requireUser(userId);
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, started_at, endpoint, request_model, status, input_tokens, output_tokens
         FROM request_logs
         WHERE user_id = ? AND started_at >= ?
         ORDER BY started_at DESC, id DESC
         LIMIT 50`,
      )
      .all(userId, since) as Array<{
      id: string;
      started_at: string;
      endpoint: string;
      request_model: string | null;
      status: number;
      input_tokens: number | null;
      output_tokens: number | null;
    }>;
    return {
      user,
      ledger: this.listLedger(userId, 50),
      requests: rows.map((row) => ({
        id: row.id,
        startedAt: row.started_at,
        endpoint: row.endpoint,
        requestModel: row.request_model,
        status: row.status,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
    };
  }

  addOperationLog(entry: Omit<OperationLog, "id" | "createdAt">): OperationLog {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO operation_logs (action, name, source, status, message, restart_required, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.action,
        entry.name,
        entry.source,
        entry.status,
        entry.message,
        entry.restartRequired ? 1 : 0,
        createdAt,
      );
    return {
      id: Number(result.lastInsertRowid),
      ...entry,
      createdAt,
    };
  }

  listOperationLogs(limit = 50): OperationLog[] {
    const rows = this.db
      .prepare("SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?")
      .all(limit) as LogRow[];
    return rows.map((row) => ({
      id: row.id,
      action: row.action as OperationLog["action"],
      name: row.name,
      source: row.source,
      status: row.status as OperationLog["status"],
      message: row.message,
      restartRequired: row.restart_required === 1,
      createdAt: row.created_at,
    }));
  }

  insertRequestLog(record: RequestLogRecord, attempts: RequestAttemptRecord[]): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO request_logs (
            id, started_at, ended_at, duration_ms, ttfb_ms, endpoint, stream, status, outcome,
            request_model, upstream_model, provider_id, connection_id, api_key_id, api_key_prefix,
            user_id, attempt_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            usage_source, error, payload_path, payload_offset, payload_truncated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.startedAt,
          record.endedAt,
          record.durationMs,
          record.ttfbMs,
          record.endpoint,
          record.stream ? 1 : 0,
          record.status,
          record.outcome,
          record.requestModel,
          record.upstreamModel,
          record.providerId,
          record.connectionId,
          record.apiKeyId,
          record.apiKeyPrefix,
          record.userId ?? null,
          record.attemptCount,
          record.inputTokens,
          record.outputTokens,
          record.cacheReadTokens,
          record.cacheWriteTokens,
          record.usageSource,
          record.error,
          record.payloadPath,
          record.payloadOffset,
          record.payloadTruncated ? 1 : 0,
        );
      const insertAttempt = this.db.prepare(
        `INSERT INTO request_attempts (
          request_id, seq, provider_id, connection_id, upstream_model, status, duration_ms, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const attempt of attempts) {
        insertAttempt.run(
          record.id,
          attempt.seq,
          attempt.providerId,
          attempt.connectionId,
          attempt.upstreamModel,
          attempt.status,
          attempt.durationMs,
          attempt.error,
        );
      }
      this.bumpRequestStats(record);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listRequestLogs(query: RequestLogListQuery = {}): RequestLogRecord[] {
    return this.listRequestLogPage(query).requests;
  }

  listRequestLogPage(query: RequestLogListQuery = {}): RequestLogPage {
    const { sql, params } = requestLogWhere(query);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(`SELECT * FROM request_logs ${sql} ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as RequestLogRow[];
    const requests = rows.map((row) => this.toRequestLog(row));
    const last = requests.length === limit ? requests[requests.length - 1] : undefined;
    return {
      requests,
      nextBefore: last ? `${last.startedAt}|${last.id}` : null,
    };
  }

  getRequestLog(id: string): { record: RequestLogRecord; attempts: RequestAttemptRecord[] } | null {
    const row = this.db.prepare("SELECT * FROM request_logs WHERE id = ?").get(id) as RequestLogRow | undefined;
    if (!row) {
      return null;
    }
    const attempts = this.db
      .prepare("SELECT * FROM request_attempts WHERE request_id = ? ORDER BY seq ASC")
      .all(id) as RequestAttemptRow[];
    return {
      record: this.toRequestLog(row),
      attempts: attempts.map((attempt) => ({
        seq: attempt.seq,
        providerId: attempt.provider_id,
        connectionId: attempt.connection_id,
        upstreamModel: attempt.upstream_model,
        status: attempt.status,
        durationMs: attempt.duration_ms,
        error: attempt.error,
      })),
    };
  }

  requestLogStats(window: RequestLogStatsWindow, now = Date.now()): RequestLogStats {
    const seconds = window === "1m" ? 60 : window === "5m" ? 300 : window === "1h" ? 3600 : 86400;
    const from = new Date(now - seconds * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT
           CAST(strftime('%s', bucket) AS INTEGER) AS ts,
           SUM(requests) AS requests,
           SUM(errors) AS errors,
           SUM(aborted) AS aborted,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens
         FROM request_stats_minute
         WHERE bucket >= ?
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(from) as Array<{
        ts: number;
        requests: number;
        errors: number;
        aborted: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
      }>;
    const totals = {
      requests: 0,
      errors: 0,
      aborted: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const series: RequestLogStats["series"] = [];
    for (const row of rows) {
      totals.requests += row.requests;
      totals.errors += row.errors;
      totals.aborted += row.aborted;
      totals.inputTokens += row.input_tokens;
      totals.outputTokens += row.output_tokens;
      totals.cacheReadTokens += row.cache_read_tokens;
      totals.cacheWriteTokens += row.cache_write_tokens;
      series.push({
        t: row.ts * 1000,
        requests: row.requests,
        tokens: row.input_tokens + row.output_tokens,
      });
    }
    const counted = Math.max(1, seconds);
    const completed = Math.max(0, totals.requests - totals.aborted);
    return {
      window,
      qps: totals.requests / counted,
      tokenTps: (totals.inputTokens + totals.outputTokens) / counted,
      inputTps: totals.inputTokens / counted,
      outputTps: totals.outputTokens / counted,
      cacheReadTps: totals.cacheReadTokens / counted,
      errorRate: completed === 0 ? 0 : totals.errors / completed,
      requests: totals.requests,
      errors: totals.errors,
      aborted: totals.aborted,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      series,
    };
  }

  queryRequestLogStats(query: RequestLogRangeQuery): RequestLogRangeStats {
    const { sql, params } = requestLogWhere(query);
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS requests,
           COALESCE(SUM(CASE WHEN outcome NOT IN ('success', 'aborted') THEN 1 ELSE 0 END), 0) AS errors,
           COALESCE(SUM(CASE WHEN outcome = 'aborted' THEN 1 ELSE 0 END), 0) AS aborted,
           COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens,
           COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens,
           COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
           COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
           COALESCE(SUM(duration_ms), 0) AS duration_ms_sum,
           COALESCE(SUM(ttfb_ms), 0) AS ttfb_sum,
           COUNT(ttfb_ms) AS ttfb_count
         FROM request_logs ${sql}`,
      )
      .get(...params) as RequestLogAggregateRow;
    const requests = numberFrom(totals.requests);
    const errors = numberFrom(totals.errors);
    const aborted = numberFrom(totals.aborted);
    const inputTokens = numberFrom(totals.input_tokens);
    const outputTokens = numberFrom(totals.output_tokens);
    const cacheReadTokens = numberFrom(totals.cache_read_tokens);
    const cacheWriteTokens = numberFrom(totals.cache_write_tokens);
    const durationSum = numberFrom(totals.duration_ms_sum);
    const ttfbCount = numberFrom(totals.ttfb_count);
    const completed = Math.max(0, requests - aborted);
    const spanMs = Date.parse(query.to) - Date.parse(query.from);
    const minutes = !Number.isFinite(spanMs) || spanMs <= 0 ? 1 : spanMs / 60_000;
    const bucket = requestLogBucket(spanMs);
    const series = (
      this.db
        .prepare(
          `SELECT ${bucketExpression(bucket)} AS t, ${REQUEST_LOG_BREAKDOWN_COLUMNS}
           FROM request_logs ${sql}
           GROUP BY t
           ORDER BY t ASC`,
        )
        .all(...params) as RequestLogAggregateRow[]
    ).map((row) => ({ t: String(row.t), ...tokenBreakdown(row) }));
    const byModel = (
      this.db
        .prepare(
          `SELECT COALESCE(request_model, '') AS model, ${REQUEST_LOG_BREAKDOWN_COLUMNS}
           FROM request_logs ${sql}
           GROUP BY 1
           ORDER BY requests DESC, model ASC
           LIMIT 20`,
        )
        .all(...params) as RequestLogAggregateRow[]
    ).map((row) => ({ model: String(row.model), ...tokenBreakdown(row) }));
    const byConnection = (
      this.db
        .prepare(
          `SELECT
             COALESCE(connection_id, '') AS connection_id,
             COALESCE(provider_id, '') AS provider_id,
             ${REQUEST_LOG_BREAKDOWN_COLUMNS}
           FROM request_logs ${sql}
           GROUP BY 1, 2
           ORDER BY requests DESC, connection_id ASC
           LIMIT 20`,
        )
        .all(...params) as RequestLogAggregateRow[]
    ).map((row) => ({
      connectionId: String(row.connection_id),
      providerId: String(row.provider_id),
      ...tokenBreakdown(row),
    }));
    return {
      from: query.from,
      to: query.to,
      requests,
      errors,
      aborted,
      errorRate: completed === 0 ? 0 : errors / completed,
      rpm: requests / minutes,
      tpm: (inputTokens + outputTokens) / minutes,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      inputTpm: inputTokens / minutes,
      outputTpm: outputTokens / minutes,
      cacheReadTpm: cacheReadTokens / minutes,
      cacheWriteTpm: cacheWriteTokens / minutes,
      avgDurationMs: requests === 0 ? null : durationSum / requests,
      avgTtfbMs: ttfbCount === 0 ? null : numberFrom(totals.ttfb_sum) / ttfbCount,
      outputTps: outputTokens > 0 && durationSum > 0 ? outputTokens / (durationSum / 1000) : null,
      series,
      byModel,
      byConnection,
    };
  }

  pruneRequestLogs(now = Date.now()): void {
    const eventCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const minuteCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM request_logs WHERE started_at < ?").run(eventCutoff);
    this.db.prepare("DELETE FROM request_stats_minute WHERE bucket < ?").run(minuteCutoff);
  }

  private bumpRequestStats(record: RequestLogRecord): void {
    const bucket = record.startedAt.slice(0, 16) + ":00.000Z";
    this.db
      .prepare(
        `INSERT INTO request_stats_minute (
          bucket, endpoint, request_model, provider_id, connection_id,
          requests, errors, aborted, duration_ms_sum,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bucket, endpoint, request_model, provider_id, connection_id) DO UPDATE SET
          requests = requests + 1,
          errors = errors + excluded.errors,
          aborted = aborted + excluded.aborted,
          duration_ms_sum = duration_ms_sum + excluded.duration_ms_sum,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
      )
      .run(
        bucket,
        record.endpoint,
        record.requestModel ?? "",
        record.providerId ?? "",
        record.connectionId ?? "",
        record.outcome !== "success" && record.outcome !== "aborted" ? 1 : 0,
        record.outcome === "aborted" ? 1 : 0,
        record.durationMs,
        record.inputTokens ?? 0,
        record.outputTokens ?? 0,
        record.cacheReadTokens ?? 0,
        record.cacheWriteTokens ?? 0,
      );
  }

  private toRequestLog(row: RequestLogRow): RequestLogRecord {
    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      ttfbMs: row.ttfb_ms,
      endpoint: row.endpoint as RequestLogEndpoint,
      stream: row.stream === 1,
      status: row.status,
      outcome: row.outcome as RequestLogOutcome,
      requestModel: row.request_model,
      upstreamModel: row.upstream_model,
      providerId: row.provider_id,
      connectionId: row.connection_id,
      apiKeyId: row.api_key_id,
      apiKeyPrefix: row.api_key_prefix,
      userId: row.user_id ?? null,
      attemptCount: row.attempt_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      usageSource: row.usage_source === "parser" ? "parser" : "missing",
      error: row.error,
      payloadPath: row.payload_path,
      payloadOffset: row.payload_offset,
      payloadTruncated: row.payload_truncated === 1,
    };
  }

  private toResolved(row: ConnectionRow): ResolvedConnection {
    return {
      connectionId: row.id,
      providerId: row.provider_id,
      credentials: row.credentials_enc ? (JSON.parse(decryptSecret(this.key, row.credentials_enc)) as unknown) : null,
    };
  }

  private toConnection(row: ConnectionRow): StoredConnection {
    return {
      id: row.id,
      providerId: row.provider_id,
      displayLabel: row.display_label?.trim() || row.id,
      hasCredentials: Boolean(row.credentials_enc),
      active: row.active === 1,
      keepaliveStatus: (row.keepalive_status as KeepaliveStatus) || "idle",
      keepaliveError: row.keepalive_error,
      keepaliveAt: row.keepalive_at,
      subscriptionStatus:
        row.subscription_status === "ok" ||
        row.subscription_status === "failed" ||
        row.subscription_status === "needs_reauth"
          ? row.subscription_status
          : "unknown",
      subscriptionError: row.subscription_error,
      subscriptionAt: row.subscription_at,
      subscriptionDueAt: row.subscription_due_at,
      subscriptionPlan: row.subscription_plan,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private requireChannel(id: string): Channel {
    const channel = this.getChannel(id);
    if (!channel) {
      throw Object.assign(new Error("channel not found"), { statusCode: 404 });
    }
    return channel;
  }

  private toApiKey(row: ApiKeyRow): StoredApiKey {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.created_at,
      userId: row.user_id ?? null,
      channelId: row.channel_id ?? null,
    };
  }

  private requireUser(id: string): GatewayUser {
    const user = this.getUser(id);
    if (!user) {
      throw Object.assign(new Error("user not found"), { statusCode: 404 });
    }
    return user;
  }

  private requireUserRow(id: string): UserRow {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    if (!row) {
      throw Object.assign(new Error("user not found"), { statusCode: 404 });
    }
    return row;
  }

  private toUser(row: UserRow): GatewayUser {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status === "disabled" ? "disabled" : "active",
      balanceUsd: formatUsd(row.balance_nano),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toLedger(row: LedgerRow): LedgerEntry {
    const reason = row.reason === "grant" || row.reason === "adjust" || row.reason === "usage" ? row.reason : "adjust";
    return {
      id: row.id,
      userId: row.user_id,
      deltaUsd: formatUsd(row.delta),
      balanceAfterUsd: formatUsd(row.balance_after),
      reason,
      requestId: row.request_id,
      note: row.note,
      createdAt: row.created_at,
    };
  }

  private requireRow(id: string): ConnectionRow {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined;
    if (!row) {
      throw Object.assign(new Error("connection not found"), { statusCode: 404 });
    }
    return row;
  }

  private requireConnection(id: string): StoredConnection {
    const connection = this.getConnection(id);
    if (!connection) {
      throw Object.assign(new Error("connection not found"), { statusCode: 404 });
    }
    return connection;
  }
}

function isPermutation(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  const remaining: Record<string, number> = {};
  for (const value of expected) {
    remaining[value] = (remaining[value] ?? 0) + 1;
  }
  for (const value of actual) {
    const count = remaining[value];
    if (!count) {
      return false;
    }
    remaining[value] = count - 1;
  }
  return true;
}

function migrateConnections(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(connections)").all() as Array<{ name: string }>;
  const names: Record<string, true> = {};
  for (const column of columns) {
    names[column.name] = true;
  }
  if (names.base_url || names.api_key_enc || names.name) {
    db.exec("DELETE FROM connections");
    db.exec("DROP TABLE connections");
    db.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        credentials_enc TEXT,
        display_label TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        keepalive_status TEXT NOT NULL DEFAULT 'idle',
        keepalive_error TEXT,
        keepalive_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
}

function migrateConnectionModels(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(connection_models)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("context_length")) {
    db.exec("ALTER TABLE connection_models ADD COLUMN context_length INTEGER");
  }
  if (!names.has("custom")) {
    db.exec("ALTER TABLE connection_models ADD COLUMN custom INTEGER NOT NULL DEFAULT 0");
  }
}

function migrateSubscription(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(connections)").all() as Array<{ name: string }>;
  const names: Record<string, true> = {};
  for (const column of columns) {
    names[column.name] = true;
  }
  const add = (name: string, definition: string): void => {
    if (!names[name]) {
      db.exec(`ALTER TABLE connections ADD COLUMN ${definition}`);
    }
  };
  add("subscription_status", "subscription_status TEXT NOT NULL DEFAULT 'unknown'");
  add("subscription_error", "subscription_error TEXT");
  add("subscription_at", "subscription_at TEXT");
  add("subscription_due_at", "subscription_due_at TEXT");
  add("subscription_plan", "subscription_plan TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS connection_usages (
      connection_id TEXT NOT NULL,
      type TEXT NOT NULL,
      position INTEGER NOT NULL,
      group_label TEXT,
      label TEXT NOT NULL,
      unit TEXT NOT NULL,
      currency TEXT,
      used REAL,
      "limit" REAL,
      remaining REAL,
      resets_at TEXT,
      unlimited INTEGER NOT NULL DEFAULT 0,
      reported INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (connection_id, type),
      FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
    );
  `);
}

function migrateUsers(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      balance_nano INTEGER NOT NULL DEFAULT 0,
      inflight INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      request_id TEXT UNIQUE,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS token_ledger_user_created ON token_ledger(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS user_usage_settlements (
      request_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_prices (
      model_id TEXT PRIMARY KEY,
      input_nano_per_million INTEGER NOT NULL,
      output_nano_per_million INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_price_overrides (
      model_id TEXT PRIMARY KEY,
      input_nano_per_million INTEGER NOT NULL,
      output_nano_per_million INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_price_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "balance_nano")) {
    db.exec("ALTER TABLE users ADD COLUMN balance_nano INTEGER NOT NULL DEFAULT 0");
  }
  const overrideColumns = db.prepare("PRAGMA table_info(model_price_overrides)").all() as Array<{ name: string }>;
  if (!overrideColumns.some((column) => column.name === "per_request_nano")) {
    db.exec("ALTER TABLE model_price_overrides ADD COLUMN per_request_nano INTEGER");
  }
  const apiKeyColumns = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
  if (!apiKeyColumns.some((column) => column.name === "user_id")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS api_keys_user_id ON api_keys(user_id)");
  const logColumns = db.prepare("PRAGMA table_info(request_logs)").all() as Array<{ name: string }>;
  if (!logColumns.some((column) => column.name === "user_id")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN user_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS request_logs_user_started ON request_logs(user_id, started_at DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_models (
      user_id TEXT NOT NULL REFERENCES users(id),
      model_id TEXT NOT NULL,
      PRIMARY KEY (user_id, model_id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_providers (
      user_id TEXT NOT NULL REFERENCES users(id),
      provider_id TEXT NOT NULL,
      PRIMARY KEY (user_id, provider_id)
    );
  `);
  migrateChannels(db);
}

function migrateChannels(db: DatabaseSync): void {
  const hadChannels = Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get(),
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ratio_numerator INTEGER NOT NULL,
      ratio_denominator INTEGER NOT NULL,
      model_rule TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_channels (
      user_id TEXT NOT NULL REFERENCES users(id),
      channel_id TEXT NOT NULL REFERENCES channels(id),
      PRIMARY KEY (user_id, channel_id)
    );
  `);
  const apiKeyColumns = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
  if (!apiKeyColumns.some((column) => column.name === "channel_id")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN channel_id TEXT");
  }
  if (hadChannels) {
    return;
  }
  const users = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number | bigint };
  const keys = db.prepare("SELECT COUNT(*) AS count FROM api_keys").get() as { count: number | bigint };
  if (Number(users.count) === 0 && Number(keys.count) === 0) {
    return;
  }
  const grokId = crypto.randomUUID();
  const standardId = crypto.randomUUID();
  const insert = db.prepare(
    `INSERT INTO channels (id, name, ratio_numerator, ratio_denominator, model_rule)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run(
    grokId,
    "Grok",
    1,
    10,
    JSON.stringify({
      kind: "match",
      providerId: "xai",
      prefix: "grok-",
      excludePrefix: "grok-imagine",
      chatOnly: true,
    }),
  );
  insert.run(standardId, "Standard", 7, 1, JSON.stringify({ kind: "all" }));
  db.prepare("INSERT INTO user_channels (user_id, channel_id) SELECT id, ? FROM users").run(grokId);
  db.prepare("UPDATE api_keys SET channel_id = ?").run(grokId);
}

function toChannel(row: ChannelRow): Channel {
  let rule: ChannelModelRule = { kind: "all" };
  try {
    rule = JSON.parse(row.model_rule) as ChannelModelRule;
  } catch {
    rule = { kind: "all" };
  }
  if (rule.kind !== "all" && rule.kind !== "match") {
    rule = { kind: "all" };
  }
  return {
    id: row.id,
    name: row.name,
    ratioNumerator: Number(row.ratio_numerator),
    ratioDenominator: Number(row.ratio_denominator),
    rule,
  };
}

type SubscriptionUsageRow = {
  connection_id: string;
  type: string;
  position: number;
  group_label: string | null;
  label: string;
  unit: string;
  currency: string | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resets_at: string | null;
  unlimited: number;
  reported: number;
};

function toSubscriptionUsage(row: SubscriptionUsageRow): StoredSubscriptionUsage {
  const unit: SubscriptionUnit =
    row.unit === "currency" || row.unit === "percent" || row.unit === "requests" || row.unit === "tokens"
      ? row.unit
      : "requests";
  return {
    connectionId: row.connection_id,
    type: row.type,
    position: row.position,
    group: row.group_label,
    label: row.label,
    unit,
    currency: row.currency,
    used: row.used,
    limit: row.limit,
    remaining: row.remaining,
    resetsAt: row.resets_at,
    unlimited: row.unlimited === 1,
    reported: row.reported === 1,
  };
}

type RequestLogAggregateRow = {
  t?: unknown;
  model?: unknown;
  connection_id?: unknown;
  provider_id?: unknown;
  requests: number | bigint;
  errors: number | bigint;
  aborted?: number | bigint;
  input_tokens: number | bigint;
  output_tokens: number | bigint;
  cache_read_tokens: number | bigint;
  cache_write_tokens: number | bigint;
  duration_ms_sum?: number | bigint;
  ttfb_sum?: number | bigint | null;
  ttfb_count?: number | bigint;
};

function numberFrom(value: number | bigint | null | undefined): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value ?? 0;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type UserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  status: string;
  balance_nano: number | bigint;
  inflight: number | bigint;
  created_at: string;
  updated_at: string;
};

type LedgerRow = {
  id: string;
  user_id: string;
  delta: number | bigint;
  balance_after: number | bigint;
  reason: string;
  request_id: string | null;
  note: string | null;
  created_at: string;
};

function normalizeEmail(email: string): string {
  const normalized = canonicalEmail(email);
  if (!normalized) {
    throw Object.assign(new Error("invalid email"), { statusCode: 400 });
  }
  return normalized;
}

function canonicalEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw Object.assign(new Error("name must be 1..80 characters"), { statusCode: 400 });
  }
  return trimmed;
}

function normalizePassword(password: string): string {
  if (password.length < 8 || password.length > 200) {
    throw Object.assign(new Error("password must be 8..200 characters"), { statusCode: 400 });
  }
  return password;
}

function cleanLedgerNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) {
    return null;
  }
  const trimmed = note.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > 200) {
    throw Object.assign(new Error("note is too long"), { statusCode: 400 });
  }
  return trimmed;
}

const REQUEST_LOG_BREAKDOWN_COLUMNS = `
  COUNT(*) AS requests,
  COALESCE(SUM(CASE WHEN outcome NOT IN ('success', 'aborted') THEN 1 ELSE 0 END), 0) AS errors,
  COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens,
  COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens,
  COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
  COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens
`;

function tokenBreakdown(row: RequestLogAggregateRow): RequestLogTokenBreakdown {
  return {
    requests: numberFrom(row.requests),
    errors: numberFrom(row.errors),
    inputTokens: numberFrom(row.input_tokens),
    outputTokens: numberFrom(row.output_tokens),
    cacheReadTokens: numberFrom(row.cache_read_tokens),
    cacheWriteTokens: numberFrom(row.cache_write_tokens),
  };
}

function requestLogBucket(spanMs: number): "minute" | "hour" | "day" {
  if (!Number.isFinite(spanMs) || spanMs <= 2 * 60 * 60 * 1000) {
    return "minute";
  }
  if (spanMs <= 48 * 60 * 60 * 1000) {
    return "hour";
  }
  return "day";
}

function bucketExpression(bucket: "minute" | "hour" | "day"): string {
  if (bucket === "minute") {
    return "substr(started_at, 1, 16) || ':00.000Z'";
  }
  if (bucket === "hour") {
    return "substr(started_at, 1, 13) || ':00:00.000Z'";
  }
  return "substr(started_at, 1, 10) || 'T00:00:00.000Z'";
}

function requestLogWhere(query: {
  from?: string;
  to?: string;
  model?: string;
  connectionId?: string;
  providerId?: string;
  keyId?: string;
  endpoint?: string;
  outcome?: string;
  before?: string;
}): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.from) {
    clauses.push("started_at >= ?");
    params.push(query.from);
  }
  if (query.to) {
    clauses.push("started_at <= ?");
    params.push(query.to);
  }
  if (query.model !== undefined) {
    clauses.push("COALESCE(request_model, '') = ?");
    params.push(query.model);
  }
  if (query.connectionId !== undefined) {
    clauses.push("COALESCE(connection_id, '') = ?");
    params.push(query.connectionId);
  }
  if (query.providerId !== undefined) {
    clauses.push("COALESCE(provider_id, '') = ?");
    params.push(query.providerId);
  }
  if (query.keyId !== undefined) {
    clauses.push("COALESCE(api_key_id, '') = ?");
    params.push(query.keyId);
  }
  if (query.endpoint) {
    clauses.push("endpoint = ?");
    params.push(query.endpoint);
  }
  if (query.outcome) {
    clauses.push("outcome = ?");
    params.push(query.outcome);
  }
  if (query.before) {
    const split = query.before.indexOf("|");
    if (split <= 0 || split === query.before.length - 1) {
      throw Object.assign(new Error("invalid before cursor"), { statusCode: 400 });
    }
    clauses.push("(started_at < ? OR (started_at = ? AND id < ?))");
    params.push(query.before.slice(0, split), query.before.slice(0, split), query.before.slice(split + 1));
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}
