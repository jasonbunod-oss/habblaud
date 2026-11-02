export interface DedupOptions {
  maxSize?: number;
  ttlMs?: number;
}

export class Dedup {
  private map = new Map<string, number>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSizeOrOpts?: number | DedupOptions, ttlMs?: number) {
    if (typeof maxSizeOrOpts === 'number') {
      this.maxSize = maxSizeOrOpts || 10000;
      this.ttlMs = ttlMs || 600000;
    } else if (maxSizeOrOpts && typeof maxSizeOrOpts === 'object') {
      this.maxSize = maxSizeOrOpts.maxSize || 10000;
      this.ttlMs = maxSizeOrOpts.ttlMs || 600000;
    } else {
      this.maxSize = 10000;
      this.ttlMs = 600000;
    }
  }

  private evict(): void {
    const now = Date.now();
    for (const [k, t] of this.map) {
      if (now - t > this.ttlMs) this.map.delete(k);
    }
    while (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value;
      if (first == null) break;
      this.map.delete(first);
    }
  }

  has(key: string): boolean {
    const t = this.map.get(key);
    if (t == null) return false;
    if (Date.now() - t > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  add(key: string): void {
    this.evict();
    this.map.set(key, Date.now());
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export { Dedup as DedupSet, Dedup as SeenSet, Dedup as LruSet };
export default Dedup;
