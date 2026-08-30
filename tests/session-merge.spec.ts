import { describe, it, expect } from 'vitest';
import { mergeZstdLines } from '../src/host/session-merge.js';

describe('mergeZstdLines', () => {
  it('unions jsonl lines', () => {
    const a = '{"seq":1}\n{"seq":2}\n';
    const b = '{"seq":2}\n{"seq":3}\n';
    const { merged, added } = mergeZstdLines(a, b);
    expect(added).toBe(1);
    expect(merged.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('idempotent', () => {
    const a = 'x\ny\n';
    const b = 'y\nz\n';
    const { merged: ab } = mergeZstdLines(a, b);
    const { added } = mergeZstdLines(ab, b);
    expect(added).toBe(0);
  });
});
