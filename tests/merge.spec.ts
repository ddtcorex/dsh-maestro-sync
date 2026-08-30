import { describe, it, expect } from 'vitest';
import { mergeDelimited, parseEntries, serializeEntries } from '../src/host/merge.js';

describe('mergeDelimited', () => {
  it('unions § entries, dedup by stripId', () => {
    const local = 'a\n§\n[id:aaaa1111] hello\n§\nworld\n';
    const remote = '[id:bbbb2222] hello\n§\nnew entry\n';
    const { mergedText, added } = mergeDelimited(local, remote);
    expect(added).toBe(1); // hello dedup, new entry added
    expect(mergedText).toContain('new entry');
    expect(mergedText.split('§').length).toBe(4); // a, hello, world, new entry
  });

  it('preserves header comment', () => {
    const local = '<!-- header -->\n§\nfoo\n';
    const remote = 'bar\n';
    const { mergedText } = mergeDelimited(local, remote);
    expect(mergedText.startsWith('<!-- header -->')).toBe(true);
  });

  it('is idempotent', () => {
    const a = 'x\n§\ny\n';
    const b = 'y\n§\nz\n';
    const { mergedText: ab } = mergeDelimited(a, b);
    const { mergedText: abb, added } = mergeDelimited(ab, b);
    expect(added).toBe(0);
    expect(abb).toBe(ab);
  });
});


