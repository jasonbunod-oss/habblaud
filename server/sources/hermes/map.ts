import { normalizeCwd } from '../../model/rooms';
import type { AgentStatus, ActivityKind } from '../../../shared/types';

export interface HermesSession {
  id: string;
  source?: string | null;
  user_id?: string | null;
  model?: string | null;
  started_at?: number | string | null;
  ended_at?: number | string | null;
  end_reason?: string | null;
  message_count?: number | null;
  tool_call_count?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  estimated_cost_usd?: number | null;
  title?: string | null;
  cwd?: string | null;
  git_branch?: string | null;
  git_repo_root?: string | null;
  parent_session_id?: string | null;
  profile_name?: string | null;
  last_activity_at?: number | string | null;
  last_activity_description?: string | null;
  created_source?: string | null;
  archived?: number | boolean | null;
  hidden?: number | boolean | null;
  [key: string]: unknown;
}

export interface HermesMessage {
  id: string | number;
  session_id?: string | null;
  role?: string | null;
  content?: unknown;
  tool_call_id?: string | null;
  tool_calls?: unknown;
  tool_name?: string | null;
  timestamp?: number | string | null;
  token_count?: number | null;
  finish_reason?: string | null;
  reasoning?: string | null;
  [key: string]: unknown;
}

export interface HermesDelegation {
  id?: string | number;
  delegation_id?: string | number;
  parent_session_id?: string | null;
  child_session_id?: string | null;
  state?: string | null;
  started_at?: number | string | null;
  updated_at?: number | string | null;
  completed_at?: number | string | null;
  result?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function lower(v: unknown): string {
  return str(v).toLowerCase();
}

function isTruthyFlag(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return /^(1|true|yes|sim|on)$/i.test(v.trim());
  return false;
}

export function hermesStatus(session: any): AgentStatus {
  const ended = session?.ended_at ?? session?.endedAt ?? session?.ended;
  const last = toMs(session?.last_activity_at ?? session?.lastActivityAt ?? session?.lastActivity);
  const desc = lower(session?.last_activity_description ?? session?.lastActivityDescription ?? session?.end_reason ?? session?.endReason);
  const isSub = !!(session?.parent_session_id ?? session?.parentSessionId);
  const now = Date.now();

  if (ended) {
    if (/error|fail|cancel|abort|crash/.test(desc)) return 'offline';
    return isSub ? 'done' : 'offline';
  }

  if (/wait|approval|confirm|input|permission/.test(desc)) {
    if (!last || now - last <= 10 * 60 * 1000) return 'waiting';
  }
  if (last && now - last <= 90_000) return 'working';
  return 'idle';
}

function contentText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === 'string') parts.push(c);
      else if (c && typeof c === 'object') {
        const o = c as Record<string, unknown>;
        if (typeof o.text === 'string') parts.push(o.text);
        else if (typeof o.content === 'string') parts.push(o.content);
      }
    }
    return parts.join(' ');
  }
  if (typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
  }
  return str(content);
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const redacted = t.replace(/(sk-|ghp_|gho_|github_pat_|xox[bp]-|eyJ)[A-Za-z0-9._-]{16,}/g, '[redacted]').replace(/[A-Za-z0-9._-]{40,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '[redacted]' : m));
  if (redacted.length <= n) return redacted;
  return redacted.slice(0, Math.max(0, n - 1)) + '…';
}

export function hermesActivityFromMessage(msg: any): { kind: ActivityKind | null; text: string } {
  const role = lower(msg?.role);
  const toolName = str(msg?.tool_name ?? msg?.toolName ?? msg?.name).trim();
  const content = contentText(msg?.content);
  const finish = lower(msg?.finish_reason ?? msg?.finishReason);
  let kind: ActivityKind | null = null;
  let text = '';

  if (finish === 'error' || lower(msg?.error).length) {
    kind = 'error';
    text = truncate(content || str(msg?.error) || 'erro', 46);
  } else if (role === 'user') {
    kind = 'prompt';
    text = truncate(content || 'nova instrução', 46);
  } else if (role === 'assistant') {
    const toolCalls = msg?.tool_calls ?? msg?.toolCalls;
    const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;
    if (hasTools) {
      const first = Array.isArray(toolCalls) ? toolCalls[0] : null;
      const name = str((first && (first as any)?.function?.name) || (first && (first as any)?.name) || toolName).trim();
      const low = name.toLowerCase();
      if (/delegate|subagent|task/.test(low)) kind = 'delegate';
      else if (/edit|patch|replace/.test(low)) kind = 'edit';
      else if (/write|create_file|save/.test(low)) kind = 'write';
      else if (/read|cat|view|open/.test(low)) kind = 'read';
      else if (/search|grep|find|glob/.test(low)) kind = 'search';
      else if (/git/.test(low)) kind = 'git';
      else if (/test/.test(low)) kind = 'test';
      else if (/web|fetch|http/.test(low)) kind = 'web';
      else if (/bash|shell|command|terminal|run/.test(low)) kind = 'run';
      else if (/plan|todo/.test(low)) kind = 'plan';
      else if (/mcp/.test(low)) kind = 'mcp';
      else if (/skill/.test(low)) kind = 'skill';
      else kind = 'other';
      text = truncate(name ? name : 'ferramenta', 46);
    } else if (content.trim()) {
      kind = 'respond';
      text = truncate(content, 46);
    } else if (msg?.reasoning || msg?.reasoning_details) {
      kind = 'think';
      text = truncate(str(msg?.reasoning ?? msg?.reasoning_details), 46);
    }
  } else if (role === 'tool') {
    kind = 'other';
    text = truncate(toolName ? `resultado ${toolName}` : 'resultado', 46);
  } else if (role === 'system') {
    kind = null;
    text = '';
  }

  if (kind === null) {
    return makeResult(null, '');
  }
  if (!text) text = kind;
  const res = makeResult(kind, text);
  return res;
}

function makeResult(kind: ActivityKind | null, text: string): { kind: ActivityKind | null; text: string } {
  return { kind, text };
}

export function hermesRoomKey(session: any): string {
  const repo = session?.git_repo_root ?? session?.gitRepoRoot ?? session?.git_repo;
  const cwd = session?.cwd ?? session?.working_directory ?? session?.workingDirectory;
  const profile = session?.profile_name ?? session?.profileName ?? session?.profile ?? 'default';
  const p = (typeof repo === 'string' && repo.trim()) ? repo : (typeof cwd === 'string' && cwd.trim() ? cwd : '');
  if (p) return normalizeCwd(String(p).replace(/\\/g, '/'));
  return `hermes:${str(profile).trim() || 'default'}`;
}

export function hermesAgentId(profile: string, sessionId: string): string {
  return `${profile}:${sessionId}`;
}
