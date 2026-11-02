import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listSessions, listMessages, listAsyncDelegations } from './db';

let files: string[] = [];
afterEach(() => {
  for (const f of files) { try { rmSync(f, { force: true }); } catch { /* ignore */ } }
  files = [];
});

function makeDb(): string {
  const p = join(tmpdir(), 'hermes-db-' + Math.random().toString(36).slice(2) + '.db');
  files.push(p);
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE sessions (id TEXT, started_at INTEGER, last_activity_at INTEGER, ended_at INTEGER, parent_session_id TEXT, archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, cwd TEXT, title TEXT, message_count INTEGER)`);
  db.exec(`CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_calls TEXT, timestamp INTEGER, finish_reason TEXT)`);
  db.exec(`CREATE TABLE async_delegations (id TEXT, delegation_id TEXT, parent_session_id TEXT, child_session_id TEXT, state TEXT, dispatched_at INTEGER, updated_at INTEGER)`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)`).run('s1', now - 100, now - 10, null, null, 0, 0, '/tmp', 'title', 2);
  db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)`).run('s2', now - 200, now - 200, now - 150, 's1', 0, 0, '/tmp', 'sub', 1);
  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)`).run('m1', 's1', 'user', 'hi there', null, null, now - 50, null);
  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)`).run('m2', 's1', 'assistant', 'ok', 'read_file', JSON.stringify([{ function: { name: 'read_file' } }]), now - 40, null);
  db.prepare(`INSERT INTO async_delegations VALUES (?,?,?,?,?,?,?)`).run('d1', 'd1', 's1', 'c1', 'running', now - 30, now - 20);
  db.close();
  return p;
}

describe('hermes db', () => {
  it('lists sessions', () => {
    const db = makeDb();
    const rows = listSessions(db);
    expect(rows.length).toBe(2);
  });

  it('filters since', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const rows = listSessions(db, now - 150);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('lists messages', () => {
    const db = makeDb();
    const rows = listMessages(db, 's1', 10);
    expect(rows.length).toBe(2);
  });

  it('lists delegations', () => {
    const db = makeDb();
    const rows = listAsyncDelegations(db);
    expect(rows.length).toBe(1);
  });

  it('returns [] on missing db', () => {
    expect(listSessions('/no/such.db')).toEqual([]);
    expect(listMessages('/no/such.db', 's1', 5)).toEqual([]);
    expect(listAsyncDelegations('/no/such.db')).toEqual([]);
  });

  it('supports flexible arg order', () => {
    const db = makeDb();
    expect(listMessages('s1', 5, db).length).toBe(2);
  });
});
