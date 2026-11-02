import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listProfiles, readGatewayState, readCronJobs, readSessionsIndex } from './files';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs = [];
});

function mkd(): string {
  const d = join(tmpdir(), 'hermes-test-' + Math.random().toString(36).slice(2));
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}

describe('hermes files', () => {
  it('discovers profiles with markers', async () => {
    const root = mkd();
    const prof = join(root, 'profiles', 'default');
    mkdirSync(prof, { recursive: true });
    writeFileSync(join(prof, 'state.db'), '');
    const list = await listProfiles(root);
    expect(list.map((p) => p.name)).toContain('default');
  });

  it('profile dir itself', async () => {
    const prof = mkd();
    writeFileSync(join(prof, 'config.yaml'), 'model: x');
    const list = await listProfiles(prof);
    expect(list).toHaveLength(1);
  });

  it('reads and redacts json', async () => {
    const root = mkd();
    writeFileSync(join(root, 'gateway_state.json'), JSON.stringify({ token: 'secret', ok: true }));
    mkdirSync(join(root, 'cron'), { recursive: true });
    writeFileSync(join(root, 'cron', 'jobs.json'), JSON.stringify({ jobs: [{ id: 1, api_key: 'x' }] }));
    mkdirSync(join(root, 'sessions'), { recursive: true });
    writeFileSync(join(root, 'sessions', 'sessions.json'), JSON.stringify({ a: 1 }));
    const gw = await readGatewayState(root);
    expect((gw as any).token).toBe('[redacted]');
    const cron = await readCronJobs(root);
    expect((cron as any).jobs[0].api_key).toBe('[redacted]');
    const sess = await readSessionsIndex(root);
    expect((sess as any).a).toBe(1);
  });

  it('returns null on missing/bad files', async () => {
    const root = mkd();
    expect(await readGatewayState(root)).toBeNull();
    writeFileSync(join(root, 'gateway_state.json'), '{bad');
    expect(await readGatewayState(root)).toBeNull();
  });
});
