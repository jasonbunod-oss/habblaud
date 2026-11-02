export interface HermesLiveOptions {
  apiUrl?: string;
  logger?: { warn?: (...a: any[]) => void };
}

export class HermesLive {
  private apiUrl?: string;
  private enabled = false;
  private logger?: HermesLiveOptions['logger'];

  constructor(opts: HermesLiveOptions = {}) {
    this.apiUrl = validateApiUrl(opts.apiUrl);
    this.logger = opts.logger;
  }

  async start(): Promise<void> {
    if (!this.apiUrl) { this.enabled = false; return; }
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.apiUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.enabled = true;
    } catch (err) {
      this.enabled = false;
      this.logger?.warn?.('[hermes] live api unreachable, disabling L3:', String(err));
    }
  }

  stop(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

function validateApiUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined;
    if (u.pathname && u.pathname !== '/' && u.pathname !== '') return undefined;
    if (u.search || u.hash) return undefined;
    const host = u.hostname.toLowerCase();
    const allowRemote = process.env.HABBLAUD_HERMES_API_ALLOW_REMOTE === '1';
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!loopback && !allowRemote) return undefined;
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

export default HermesLive;
