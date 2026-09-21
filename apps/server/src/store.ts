import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import {
  parseAdvertisedEndpointTypes,
  VIATE_PUBLIC_ENDPOINT_TYPES,
  type ProxyEndpointType,
} from "./endpoints.js";
import { decryptSecret, encryptSecret, loadOrCreateCredentialKey } from "./crypto.js";

export type KeepaliveStatus = "idle" | "ok" | "failed" | "needs_reauth";

export type StoredConnection = {
  id: string;
  providerId: string;
  displayLabel: string;
  hasCredentials: boolean;
  active: boolean;
  keepaliveStatus: KeepaliveStatus;
  keepaliveError: string | null;
  keepaliveAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredModel = {
  id: string;
  name: string;
  enabled: boolean;
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

export type RequestLogEndpoint = "chat.completions" | "embeddings" | "responses" | "responses.compact";

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
  keyId?: string;
  outcome?: RequestLogOutcome;
  limit?: number;
};

export type StoredApiKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
};

export type CreatedApiKey = {
  apiKey: StoredApiKey;
  secret: string;
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

export type LkgpRecord = {
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
    return new AdminStore(db, key, dataDir);
  }

  close(): void {
    this.db.close();
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
    return this.requireConnection(id);
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
    return this.requireConnection(id);
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
  }

  getConnectionModels(id: string): ConnectionModelCatalog {
    this.requireRow(id);
    const rows = this.db
      .prepare(
        `SELECT model_id, name, enabled, synced_at, context_length
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
      }>;
    if (rows.length === 0) {
      return { connectionId: id, syncedAt: null, models: [] };
    }
    return {
      connectionId: id,
      syncedAt: rows[0]?.synced_at ?? null,
      models: rows.map((row) => ({
        id: row.model_id,
        name: row.name,
        enabled: row.enabled === 1,
        ...(typeof row.context_length === "number" ? { contextLength: row.context_length } : {}),
      })),
    };
  }

  replaceConnectionModels(
    id: string,
    models: Array<{ id: string; name?: string; context_length?: number }>,
  ): ConnectionModelCatalog {
    this.requireRow(id);
    const previous = new Map(
      (this.getConnectionModels(id)?.models ?? []).map((model) => [model.id, model]),
    );
    const seen = new Set<string>();
    const next: StoredModel[] = [];
    for (const model of models) {
      const modelId = model.id.trim();
      if (!modelId || seen.has(modelId)) {
        continue;
      }
      seen.add(modelId);
      const context =
        typeof model.context_length === "number" && Number.isFinite(model.context_length) && model.context_length > 0
          ? Math.trunc(model.context_length)
          : undefined;
      next.push({
        id: modelId,
        name: model.name?.trim() || modelId,
        enabled: previous.get(modelId)?.enabled ?? true,
        ...(context ? { contextLength: context } : {}),
      });
    }
    const syncedAt = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM connection_models WHERE connection_id = ?").run(id);
      const insert = this.db.prepare(
        `INSERT INTO connection_models (connection_id, model_id, name, enabled, synced_at, context_length)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const model of next) {
        insert.run(id, model.id, model.name, model.enabled ? 1 : 0, syncedAt, model.contextLength ?? null);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { connectionId: id, syncedAt, models: next };
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

  listPublicCatalog(): { object: "list"; data: PublicModel[] } {
    const grouped = this.groupPublishedMembers(this.listPublishedMembers());
    const data: PublicModel[] = [];
    for (const modelId of [...grouped.keys()].sort()) {
      data.push(this.toPublicModel(modelId, grouped.get(modelId) ?? []));
    }
    return { object: "list", data };
  }

  getAdvertisedEndpointTypes(providerId: string): ProxyEndpointType[] {
    const id = providerId.trim();
    if (!id) {
      return [...VIATE_PUBLIC_ENDPOINT_TYPES];
    }
    const row = this.db
      .prepare("SELECT endpoint_types FROM provider_advertised_endpoints WHERE provider_id = ?")
      .get(id) as { endpoint_types: string } | undefined;
    if (!row) {
      return [...VIATE_PUBLIC_ENDPOINT_TYPES];
    }
    try {
      return parseAdvertisedEndpointTypes(JSON.parse(row.endpoint_types) as unknown);
    } catch {
      return [...VIATE_PUBLIC_ENDPOINT_TYPES];
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

  listApiKeys(): StoredApiKey[] {
    const rows = this.db
      .prepare("SELECT * FROM api_keys ORDER BY created_at DESC, id")
      .all() as ApiKeyRow[];
    return rows.map((row) => this.toApiKey(row));
  }

  createApiKey(name: string): CreatedApiKey {
    const trimmed = name.trim();
    if (!trimmed) {
      throw Object.assign(new Error("name is required"), { statusCode: 400 });
    }
    const secret = `viate_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const prefix = secret.slice(0, 12);
    this.db
      .prepare("INSERT INTO api_keys (id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, trimmed, prefix, createHmac("sha256", this.key).update(secret).digest("hex"), createdAt);
    return {
      apiKey: { id, name: trimmed, prefix, createdAt },
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
            attempt_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            usage_source, error, payload_path, payload_offset, payload_truncated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.from) {
      clauses.push("started_at >= ?");
      params.push(query.from);
    }
    if (query.to) {
      clauses.push("started_at <= ?");
      params.push(query.to);
    }
    if (query.model) {
      clauses.push("request_model = ?");
      params.push(query.model);
    }
    if (query.connectionId) {
      clauses.push("connection_id = ?");
      params.push(query.connectionId);
    }
    if (query.keyId) {
      clauses.push("api_key_id = ?");
      params.push(query.keyId);
    }
    if (query.outcome) {
      clauses.push("outcome = ?");
      params.push(query.outcome);
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM request_logs ${where} ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as RequestLogRow[];
    return rows.map((row) => this.toRequestLog(row));
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toApiKey(row: ApiKeyRow): StoredApiKey {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
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
  if (columns.some((column) => column.name === "context_length")) {
    return;
  }
  db.exec("ALTER TABLE connection_models ADD COLUMN context_length INTEGER");
}
