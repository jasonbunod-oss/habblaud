import { describe, expect, it } from 'vitest';
import {
  hermesStatus,
  hermesActivityFromMessage,
  hermesRoomKey,
  hermesAgentId,
} from './map';

describe('hermes map', () => {
  it('status: ended with error -> offline', () => {
    expect(hermesStatus({ ended_at: 1, last_activity_description: 'error: boom' })).toBe('offline');
  });

  it('status: ended subagent -> done', () => {
    expect(hermesStatus({ ended_at: 1, parent_session_id: 'p' })).toBe('done');
  });

  it('status: ended main -> offline', () => {
    expect(hermesStatus({ ended_at: 1 })).toBe('offline');
  });

  it('status: recent activity -> working', () => {
    expect(hermesStatus({ last_activity_at: Date.now(), last_activity_description: 'running' })).toBe('working');
  });

  it('status: waiting description', () => {
    expect(hermesStatus({ last_activity_at: Date.now(), last_activity_description: 'waiting for approval' })).toBe('waiting');
  });

  it('status: stale -> idle', () => {
    expect(hermesStatus({ last_activity_at: Date.now() - 10 * 60 * 1000 })).toBe('idle');
  });

  it('activity from user message', () => {
    const r = hermesActivityFromMessage({ role: 'user', content: 'hello world' });
    expect(r.kind).toBe('prompt');
    expect(r.text).toContain('hello');
    expect(Array.isArray(r)).toBe(true);
    expect(r[0]).toBe('prompt');
  });

  it('activity from assistant tool call', () => {
    const r = hermesActivityFromMessage({
      role: 'assistant',
      tool_calls: [{ function: { name: 'read_file' } }],
    });
    expect(r.kind).toBe('read');
  });

  it('activity null for empty system', () => {
    const r = hermesActivityFromMessage({ role: 'system', content: '' });
    expect(r.kind).toBeNull();
  });

  it('room key from repo/cwd/profile', () => {
    expect(hermesRoomKey({ git_repo_root: '/repo', cwd: '/tmp', profile_name: 'p' })).toBeTruthy();
    expect(hermesRoomKey({ cwd: '/tmp/x' })).toContain('tmp');
    expect(hermesRoomKey({ profile_name: 'default' })).toBe('hermes:default');
  });

  it('agent id stable', () => {
    expect(hermesAgentId('prof', 'sess')).toBe('prof:sess');
  });
});
