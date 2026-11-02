import { describe, expect, it } from 'vitest';
import { Dedup } from './dedup';

describe('hermes dedup', () => {
  it('has/add basics', () => {
    const d = new Dedup(10, 1000);
    expect(d.has('a')).toBe(false);
    d.add('a');
    expect(d.has('a')).toBe(true);
  });

  it('evicts by size', () => {
    const d = new Dedup(2, 100000);
    d.add('a');
    d.add('b');
    d.add('c');
    expect(d.size).toBeLessThanOrEqual(2);
  });

  it('expires by ttl', async () => {
    const d = new Dedup(10, 10);
    d.add('a');
    await new Promise((r) => setTimeout(r, 25));
    expect(d.has('a')).toBe(false);
  });
});
