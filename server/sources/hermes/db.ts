import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

function isDbPath(v: unknown): boolean {
  return typeof v === 'string' && (v.endsWith('.db') || v.includes(path.sep) || v.includes('/') || v.includes('\\'));
}

function openDb(dbPath: string): DatabaseSync | null {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* ignore */ }
    return db;
  } catch (err) {
    console.warn('[hermes] cannot open db (read-only):', dbPath, String(err));
    return null;
  }
}

function closeDb(db: DatabaseSync | null): void {
  if (!db) return;
  try { db.close(); } catch { /* ignore */ }
}

function normalizeSince(since?: number): number | undefined {
  if (since == null) return undefined;
  return since > 1e12 ? Math.floor(since / 1000) : since;
}

function rowsOf<T>(db: DatabaseSync, sql: string, params: unknown[] = []): T[] {
  try {
    const stmt = db.prepare(sql);
    const r = stmt.all(...(params as any)) as T[];
    return Array.isArray(r) ? r : [];
  } catch (err) {
    console.warn('[hermes] query failed:', String(err));
    return [];
  }
}

function parseListSessionsArgs(args: any[]): { dbPath?: string; since?: number } {
  let dbPath: string | undefined;
  let since: number | undefined;
  for (const a of args) {
    if (typeof a === 'string') dbPath = a;
    else if (typeof a === 'number') since = a;
  }
  return { dbPath, since };
}

function parseListMessagesArgs(args: any[]): { dbPath?: string; sessionId?: string; limit: number } {
  let dbPath: string | undefined;
  let sessionId: string | undefined;
  let limit = 50;
  for (const a of args) {
    if (typeof a === 'string') {
      if (isDbPath(a)) {
        if (dbPath == null) dbPath = a;
      } else {
        if (sessionId == null) sessionId = a;
      }
    } else if (typeof a === 'number') {
      limit = a;
    }
  }
  return { dbPath, sessionId, limit };
}

function parseListDelegationsArgs(args: any[]): { dbPath?: string; since?: number } {
  let dbPath: string | undefined;
  let since: number | undefined;
  for (const a of args) {
    if (typeof a === 'string') dbPath = a;
    else if (typeof a === 'number') since = a;
  }
  return { dbPath, since };
}

export function listSessions(...args: any[]): Record<string, unknown>[] {
  const { dbPath, since } = parseListSessionsArgs(args);
  if (!dbPath) return [];
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    const sinceDb = normalizeSince(since);
    const where = sinceDb != null
      ? 'WHERE (last_activity_at IS NULL OR last_activity_at >= ?) OR (last_activity_at IS NULL AND started_at >= ?)'
      : '';
    const params = sinceDb != null ? [sinceDb, sinceDb] : [];
    const sql = `SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT 500`;
    return rowsOf<Record<string, unknown>>(db, sql, params);
  } catch (err) {
    console.warn('[hermes] listSessions failed:', String(err));
    return [];
  } finally {
    closeDb(db);
  }
}

export function listMessages(...args: any[]): Record<string, unknown>[] {
  const { dbPath, sessionId, limit } = parseListMessagesArgs(args);
  if (!dbPath || !sessionId) return [];
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    const n = Math.max(1, Math.min(500, limit || 50));
    const sql = `SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`;
    return rowsOf<Record<string, unknown>>(db, sql, [sessionId, n]);
  } catch (err) {
    console.warn('[hermes] listMessages failed:', String(err));
    return [];
  } finally {
    closeDb(db);
  }
}

export function listAsyncDelegations(...args: any[]): Record<string, unknown>[] {
  const { dbPath, since } = parseListDelegationsArgs(args);
  if (!dbPath) return [];
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    const sinceDb = normalizeSince(since);
    const where = sinceDb != null ? 'WHERE updated_at IS NULL OR updated_at >= ? OR dispatched_at >= ?' : '';
    const params = sinceDb != null ? [sinceDb, sinceDb] : [];
    const sql = `SELECT * FROM async_delegations ${where} ORDER BY updated_at DESC LIMIT 200`;
    return rowsOf<Record<string, unknown>>(db, sql, params);
  } catch (err) {
    console.warn('[hermes] listAsyncDelegations failed:', String(err));
    return [];
  } finally {
    closeDb(db);
  }
}
