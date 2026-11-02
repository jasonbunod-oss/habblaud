import { setInterval as setTimer, clearInterval as clearTimer } from 'node:timers';
import { listProfiles } from './files';
import { listSessions, listMessages, listAsyncDelegations } from './db';
import { hermesStatus, hermesActivityFromMessage, hermesRoomKey, hermesAgentId } from './map';
import { Dedup } from './dedup';
import { HermesHistoryProvider } from './history';
import { HermesLive } from './live';
import { tr } from '../../../shared/i18n';
import type { AgentSource, HistoryProvider } from '../source';
import type { Office } from '../../model/office';
import type { Provider } from '../../../shared/types';

export interface HermesSourceOptions {
  accounts?: any;
  profiles?: any;
  dirs?: string[];
  dataDir?: string;
  apiUrl?: string;
  office: Office;
  logger?: { log?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void };
}

interface ProfileRef { id: string; dir: string }

export class HermesSource implements AgentSource {
  readonly provider: Provider = 'hermes';
  private office: Office;
  private dataDirs: string[];
  private apiUrl?: string;
  private logger: { log: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  private profiles: ProfileRef[] = [];
  private accountsInput: any;
  private profilesInput: any;
  private interval: any = null;
  private knownSessions = new Set<string>();
  private seenMessages = new Dedup(50000, 10 * 60 * 1000);
  private live?: HermesLive;
  private started = false;

  constructor(opts: HermesSourceOptions) {
    this.office = opts.office;
    this.dataDirs = opts.dirs && opts.dirs.length ? opts.dirs : (opts.dataDir ? [opts.dataDir] : []);
    this.apiUrl = opts.apiUrl;
    this.logger = {
      log: opts.logger?.log?.bind(opts.logger) ?? console.log.bind(console),
      warn: opts.logger?.warn?.bind(opts.logger) ?? console.warn.bind(console),
      error: opts.logger?.error?.bind(opts.logger) ?? console.error.bind(console),
    };
    this.accountsInput = opts.accounts;
    this.profilesInput = opts.profiles;
  }

  private async discoverProfiles(): Promise<ProfileRef[]> {
    const out: ProfileRef[] = [];
    // accounts may be a list of profile objects/strings
    const accounts = this.accountsInput;
    if (Array.isArray(accounts)) {
      for (const a of accounts) {
        if (typeof a === 'string') out.push({ id: a, dir: a });
        else if (a && typeof a === 'object') {
          const id = String(a.id ?? a.name ?? a.profile ?? a.label ?? '');
          const dir = String(a.dir ?? a.path ?? a.dataDir ?? a.configDir ?? id);
          if (id || dir) out.push({ id: id || dir, dir });
        }
      }
      if (out.length) return out;
    }
    // accounts may be AccountsService-like
    if (accounts && typeof accounts === 'object' && typeof accounts.entries === 'function') {
      try {
        const entries = accounts.entries();
        for (const e of (Array.isArray(entries) ? entries : [])) {
          const id = String(e?.id ?? e?.name ?? '');
          const dir = String(e?.dir ?? e?.path ?? e?.configDir ?? '');
          if (id || dir) out.push({ id: id || dir, dir: dir || id });
        }
        if (out.length) return out;
      } catch { /* ignore */ }
    }
    if (Array.isArray(this.profilesInput)) {
      for (const p of this.profilesInput) {
        if (typeof p === 'string') out.push({ id: p, dir: p });
        else if (p && typeof p === 'object') {
          const id = String(p.id ?? p.name ?? p.profile ?? '');
          const dir = String(p.dir ?? p.path ?? p.dataDir ?? id);
          if (id || dir) out.push({ id: id || dir, dir: dir || id });
        }
      }
      if (out.length) return out;
    }
    // discover from data dirs
    for (const d of this.dataDirs) {
      try {
        const profs = await listProfiles(d);
        for (const p of profs) out.push({ id: p.name, dir: p.dir });
      } catch (err) {
        this.logger.warn('[hermes] profile discovery failed:', d, String(err));
      }
    }
    // if none, treat each data dir as a profile
    if (!out.length) {
      for (const d of this.dataDirs) out.push({ id: d, dir: d });
    }
    return out;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.office.beginBoot?.();
    try {
      this.profiles = await this.discoverProfiles();
      this.live = new HermesLive({ apiUrl: this.apiUrl, logger: this.logger });
      await this.live.start();
      await this.syncOnce(true);
      this.interval = setTimer(() => {
        this.syncOnce(false).catch((err) => this.logger.warn('[hermes] sync failed:', String(err)));
      }, 5000);
    } catch (err) {
      this.logger.error('[hermes] start failed:', String(err));
    } finally {
      this.office.endBoot?.();
    }
  }

  stop(): void {
    if (this.interval) {
      clearTimer(this.interval);
      this.interval = null;
    }
    try { this.live?.stop(); } catch { /* ignore */ }
  }

  sources(): any[] {
    return this.profiles.map((p) => ({
      label: p.id,
      provider: 'hermes',
      path: p.dir,
      sessions: 0,
      ok: true,
    }));
  }

  transcriptPathOf(_agentId: string): string | undefined {
    return undefined;
  }

  getHistoryProvider(): HistoryProvider {
    return new HermesHistoryProvider(this.profiles.map((p) => ({ id: p.id, dir: p.dir })));
  }

  private async syncOnce(_boot: boolean): Promise<void> {
    const currentIds = new Set<string>();
    for (const profile of this.profiles) {
      const dbPath = profile.dir.endsWith('state.db') ? profile.dir : `${profile.dir}/state.db`;
      // sessions
      let sessions: Record<string, unknown>[] = [];
      try {
        sessions = listSessions(dbPath);
      } catch (err) {
        this.logger.warn('[hermes] listSessions failed:', String(err));
      }
      // filter archived/hidden
      const visible = sessions.filter((s) => {
        const archived = s.archived ?? s.is_archived ?? s.archived_at;
        const hidden = s.hidden ?? s.is_hidden;
        return !archived && !hidden;
      });

      for (const session of visible) {
        const sessionId = String(session.id ?? session.session_id ?? '');
        if (!sessionId) continue;
        const agentId = hermesAgentId(profile.id, sessionId);
        currentIds.add(agentId);
        const status = hermesStatus(session);
        const isSub = !!(session.parent_session_id ?? session.parentSessionId);
        const roomKey = hermesRoomKey(session);
        const cwd = (session.cwd as string) || (session.git_repo_root as string) || '/';
        const startedAt = Number(session.started_at ?? session.startedAt ?? Date.now() / 1000);
        const startedMs = startedAt < 1e12 ? startedAt * 1000 : startedAt;

        if (!this.knownSessions.has(agentId)) {
          // new
          const payload = {
          id: agentId,
          provider: 'hermes',
          account: profile.id,
          sessionId,
          cwd,
          role: (session.title as string) || tr('Agente principal'),
          startedAt: startedMs,
          status,
          };
          try {
            if (isSub) {
              const parentRaw = session.parent_session_id ?? session.parentSessionId;
              const parentId = parentRaw ? hermesAgentId(profile.id, String(parentRaw)) : undefined;
              if (parentId && this.office.has?.(parentId)) {
                this.office.addSub?.({ ...payload, parentId } as any);
              } else {
                this.office.addMain?.(payload as any);
              }
            } else {
              this.office.addMain?.(payload as any);
            }
          } catch (err) {
            this.logger.warn('[hermes] add agent failed:', String(err));
          }
          this.knownSessions.add(agentId);
        } else {
          try { this.office.setStatus?.(agentId, status); } catch { /* ignore */ }
        }

        // messages -> activities
        try {
          const msgs = listMessages(dbPath, sessionId, 20);
          for (const m of [...msgs].reverse()) {
            const msgId = String(m.id ?? m.message_id ?? `${sessionId}:${m.timestamp}`);
            const dedupKey = `${profile.id}:${sessionId}:${msgId}`;
            if (this.seenMessages.has(dedupKey)) continue;
            const mapped = hermesActivityFromMessage(m);
            if (!mapped || !mapped.kind) { this.seenMessages.add(dedupKey); continue; }
            const atRaw = Number(m.timestamp ?? m.created_at ?? Date.now() / 1000);
            const at = atRaw < 1e12 ? atRaw * 1000 : atRaw;
            try {
              this.office.addActivity?.(agentId, {
                id: `${agentId}#${msgId}`,
                kind: mapped.kind,
                icon: '💬',
                text: mapped.text,
                at,
              } as any, true);
            } catch { /* ignore */ }
            this.seenMessages.add(dedupKey);
          }
        } catch (err) {
          this.logger.warn('[hermes] messages failed:', String(err));
        }
      }

      // async delegations -> subagents
      try {
        const delegs = listAsyncDelegations(dbPath);
        for (const d of delegs) {
          const parentRaw = d.parent_session_id ?? d.parentSessionId;
          if (!parentRaw) continue;
          const parentId = hermesAgentId(profile.id, String(parentRaw));
          if (!this.knownSessions.has(parentId)) continue;
          const delegationId = String(d.id ?? d.delegation_id ?? d.child_session_id ?? '');
          if (!delegationId) continue;
          const subId = `${parentId}:del:${delegationId}`;
          const state = String(d.state ?? d.status ?? 'running').toLowerCase();
          const dispatchedRaw = d.dispatched_at ?? d.dispatchedAt ?? d.started_at ?? d.startedAt;
          const startedMs = dispatchedRaw != null
            ? (Number(dispatchedRaw) < 1e12 ? Number(dispatchedRaw) * 1000 : Number(dispatchedRaw))
            : Date.now();
          if (state === 'running' || state === 'pending') {
            currentIds.add(subId);
            if (!this.knownSessions.has(subId)) {
              try {
                this.office.addSub?.({
                  id: subId,
                  parentId,
                  sessionId: String(d.child_session_id ?? delegationId),
                  role: tr('Subagente'),
                  startedAt: startedMs,
                  status: 'working',
                  background: false,
                } as any);
                this.knownSessions.add(subId);
              } catch { /* ignore */ }
            }
          } else {
            if (this.knownSessions.has(subId)) {
              try { this.office.completeSub?.(subId, { notify: false } as any); } catch { /* ignore */ }
              this.knownSessions.delete(subId);
            }
          }
        }
      } catch (err) {
        this.logger.warn('[hermes] delegations failed:', String(err));
      }
    }

    // remove gone sessions (grace: remove immediately)
    for (const id of [...this.knownSessions]) {
      if (!currentIds.has(id) && !id.includes(':del:')) {
        // only remove if not a delegation tracked? Remove all gone.
        try { this.office.closeMain?.(id); } catch { /* ignore */ }
        try { this.office.completeSub?.(id, { notify: false } as any); } catch { /* ignore */ }
        this.knownSessions.delete(id);
      }
    }
    // remove gone delegations
    for (const id of [...this.knownSessions]) {
      if (id.includes(':del:') && !currentIds.has(id)) {
        try { this.office.completeSub?.(id, { notify: false } as any); } catch { /* ignore */ }
        this.knownSessions.delete(id);
      }
    }
  }
}

export default HermesSource;
