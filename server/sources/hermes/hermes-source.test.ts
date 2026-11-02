import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesSource } from './source';

let dir: string;
let dbPath: string;

function makeDb(p: string) {
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE sessions (id TEXT, started_at INTEGER, last_activity_at INTEGER, ended_at INTEGER, parent_session_id TEXT, archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, cwd TEXT, title TEXT, message_count INTEGER)`);
  db.exec(`CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_calls TEXT, timestamp INTEGER, finish_reason TEXT)`);
  db.exec(`CREATE TABLE async_delegations (id TEXT, delegation_id TEXT, parent_session_id TEXT, child_session_id TEXT, state TEXT, dispatched_at INTEGER, updated_at INTEGER)`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)`).run('s1', now - 100, now - 10, null, null, 0, 0, '/tmp', 'title', 2);
  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)`).run('m1', 's1', 'user', 'hi there', null, null, now - 50, null);
  db.close();
}

beforeEach(() => {
  dir = join(tmpdir(), 'hermes-src-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, 'state.db');
  makeDb(dbPath);
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('HermesSource integration', () => {
  it('boots, discovers sessions, and adds main agent', async () => {
    const office: any = {
      beginBoot: vi.fn(),
      endBoot: vi.fn(),
      has: vi.fn(() => false),
      addMain: vi.fn(),
      addSub: vi.fn(),
      addActivity: vi.fn(),
      setStatus: vi.fn(),
      closeMain: vi.fn(),
      completeSub: vi.fn(),
    };
    const src = new HermesSource({ office, dirs: [dir], logger: { log() {}, warn() {}, error() {} } });
    await src.start();
    expect(office.beginBoot).toHaveBeenCalled();
    expect(office.endBoot).toHaveBeenCalled();
    expect(office.addMain).toHaveBeenCalled();
    const payload = office.addMain.mock.calls[0][0];
    expect(payload.provider).toBe('hermes');
    expect(payload.sessionId).toBe('s1');
    src.stop();
  });

  it('handles missing db gracefully (no throw)', async () => {
    const emptyDir = join(tmpdir(), 'hermes-empty-' + Math.random().toString(36).slice(2));
    mkdirSync(emptyDir, { recursive: true });
    const office: any = {
      beginBoot: vi.fn(), endBoot: vi.fn(),
      has: vi.fn(() => false), addMain: vi.fn(), addSub: vi.fn(),
      addActivity: vi.fn(), setStatus: vi.fn(), closeMain: vi.fn(), completeSub: vi.fn(),
    };
    const src = new HermesSource({ office, dirs: [emptyDir], logger: { log() {}, warn() {}, error() {} } });
    await expect(src.start()).resolves.not.toThrow();
    src.stop();
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
