import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "viate_admin";
export const CSRF_COOKIE = "viate_csrf";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type SessionRecord = {
  id: string;
  csrf: string;
  expiresAt: number;
};

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(): SessionRecord {
    this.purge();
    const record: SessionRecord = {
      id: randomBytes(32).toString("hex"),
      csrf: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  get(id: string | undefined): SessionRecord | null {
    if (!id) {
      return null;
    }
    const record = this.sessions.get(id);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return record;
  }

  revoke(id: string | undefined): void {
    if (id) {
      this.sessions.delete(id);
    }
  }

  private purge(): void {
    const now = Date.now();
    for (const [id, record] of this.sessions) {
      if (record.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }
}

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join("; ") : header ?? "";
  const cookies: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) {
      continue;
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearCookieHeader(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function csrfEqual(expected: string, provided: string | undefined): boolean {
  if (!provided) {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
