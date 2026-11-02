import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|auth|credential|private|cookie|session|bearer|passphrase|certificate|jwt)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) out[k] = '[redacted]';
      else out[k] = redact(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (/^(sk-|ghp_|gho_|github_pat_|xox[bp]-|eyJ)[A-Za-z0-9._-]{16,}$/.test(value)) return '[redacted]';
  }
  return value;
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return redact(parsed);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export interface HermesProfileInfo {
  name: string;
  dir: string;
  hasStateDb: boolean;
  hasConfig: boolean;
}

async function hasMarkers(dir: string): Promise<{ db: boolean; config: boolean }> {
  const db = await exists(path.join(dir, 'state.db'));
  const config = await exists(path.join(dir, 'config.yaml')) || await exists(path.join(dir, 'config.yml'));
  return { db, config };
}

export async function listProfiles(dataDir: string): Promise<HermesProfileInfo[]> {
  const out: HermesProfileInfo[] = [];
  const seen = new Set<string>();
  const add = async (dir: string) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    const markers = await hasMarkers(resolved);
    if (!markers.db && !markers.config) return;
    seen.add(resolved);
    out.push({ name: path.basename(resolved), dir: resolved, hasStateDb: markers.db, hasConfig: markers.config });
  };

  try {
    // If a profiles/ subdirectory exists, treat dataDir as a container, not a profile.
    const profilesDir = path.join(dataDir, 'profiles');
    const hasProfilesDir = await isDir(profilesDir);
    if (!hasProfilesDir) {
      const selfMarkers = await hasMarkers(dataDir);
      if (selfMarkers.db || selfMarkers.config) {
        await add(dataDir);
        return out;
      }
    }

    // profiles/ subdirectory.
    if (hasProfilesDir) {
      const entries = await readdir(profilesDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        if (!e.isDirectory()) continue;
        await add(path.join(profilesDir, e.name));
      }
    }

    // direct children with markers.
    const entries = await readdir(dataDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (!e.isDirectory()) continue;
      await add(path.join(dataDir, e.name));
    }
  } catch {
    // never throw
  }
  return out;
}

export async function discoverProfiles(dataDir: string): Promise<HermesProfileInfo[]> {
  return listProfiles(dataDir);
}

export async function listHermesProfiles(dataDir: string): Promise<HermesProfileInfo[]> {
  return listProfiles(dataDir);
}

export async function listProfileDirs(dataDir: string): Promise<string[]> {
  const profiles = await listProfiles(dataDir);
  return profiles.map((p) => p.dir);
}

export async function readGatewayState(dataDir: string): Promise<Record<string, unknown> | null> {
  return (await readJsonFile(path.join(dataDir, 'gateway_state.json'))) as Record<string, unknown> | null;
}

export async function readCronJobs(dataDir: string): Promise<Record<string, unknown> | null> {
  const direct = await readJsonFile(path.join(dataDir, 'cron', 'jobs.json'));
  if (direct) return direct as Record<string, unknown>;
  return (await readJsonFile(path.join(dataDir, 'jobs.json'))) as Record<string, unknown> | null;
}

export async function readSessionsIndex(dataDir: string): Promise<Record<string, unknown> | null> {
  const direct = await readJsonFile(path.join(dataDir, 'sessions', 'sessions.json'));
  if (direct) return direct as Record<string, unknown>;
  return (await readJsonFile(path.join(dataDir, 'sessions.json'))) as Record<string, unknown> | null;
}
