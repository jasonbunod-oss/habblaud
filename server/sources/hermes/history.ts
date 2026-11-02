import { listSessions } from './db';
import type { HistoryProvider } from '../source';
import type { RecentSession } from '../../../shared/types';
import type { Provider } from '../../../shared/types';

const HISTORY_LIMIT = 150;

export class HermesHistoryProvider implements HistoryProvider {
  readonly provider: Provider = 'hermes';
  private profiles: Array<{ id: string; dir: string }> = [];
  private dirs: string[] = [];

  constructor(input: any = []) {
    if (Array.isArray(input)) {
      this.profiles = input.map((p: any) => ({ id: String(p?.id ?? p?.name ?? p), dir: String(p?.dir ?? p?.path ?? p) }));
    } else if (input && typeof input === 'object') {
      if (Array.isArray(input.profiles)) {
        this.profiles = input.profiles.map((p: any) => ({ id: String(p?.id ?? p?.name ?? p), dir: String(p?.dir ?? p?.path ?? p) }));
      }
      if (Array.isArray(input.dirs)) this.dirs = input.dirs.map(String);
      if (typeof input.dataDir === 'string') this.dirs.push(input.dataDir);
    }
  }

  hasAccount(account: string): boolean {
    return this.profiles.some((p) => p.id === account);
  }

  async list(): Promise<RecentSession[]> {
    if (!this.profiles.length && this.dirs.length) {
      for (const d of this.dirs) {
        try {
          const { listProfiles } = await import('./files');
          const profs = await listProfiles(d);
          for (const p of profs) this.profiles.push({ id: p.name, dir: p.dir });
        } catch { /* ignore */ }
      }
    }
    const out: RecentSession[] = [];
    for (const p of this.profiles) {
      const dbPath = p.dir.endsWith('state.db') ? p.dir : `${p.dir}/state.db`;
      let sessions: Record<string, unknown>[] = [];
      try {
        sessions = listSessions(dbPath);
      } catch {
        sessions = [];
      }
      for (const s of sessions) {
        const sessionId = String(s.id ?? s.session_id ?? '');
        if (!sessionId) continue;
        const started = Number(s.started_at ?? s.startedAt ?? Date.now() / 1000);
        const last = Number(s.last_activity_at ?? s.last_activity ?? s.started_at ?? started);
        const toMs = (v: number) => (v < 1e12 ? v * 1000 : v);
        out.push({
          account: p.id,
          provider: 'hermes',
          sessionId,
          project: (s.cwd as string) || (s.git_repo_root as string) || undefined,
          projectDir: String(s.cwd ?? s.git_repo_root ?? p.id),
          title: (s.title as string) || undefined,
          firstAt: toMs(started),
          lastAt: toMs(last),
          size: Number(s.message_count ?? 0),
          open: !(s.ended_at ?? s.endedAt),
          agentId: `${p.id}:${sessionId}`,
        } as RecentSession);
      }
    }
    out.sort((a, b) => b.lastAt - a.lastAt);
    return out.slice(0, HISTORY_LIMIT);
  }

  resolve(_account: string, _sessionId: string): any {
    return { status: 404, error: 'not found' };
  }
}

export default HermesHistoryProvider;
