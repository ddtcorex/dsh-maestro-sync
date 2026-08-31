import { describe, it, expect } from 'vitest';
import { hashBuffer, snapshotFile } from '../src/host/snapshot.js';

describe('snapshot', () => {
  it('hashes buffer deterministically', async () => {
    const buf = Buffer.from('hello');
    expect(hashBuffer(buf)).toBe(hashBuffer(Buffer.from('hello')));
    expect(hashBuffer(buf)).not.toBe(hashBuffer(Buffer.from('world')));
  });

  it('creates snapshot for eligible path', async () => {
    const snap = await snapshotFile('memories/daily/2026-08-29.md', Buffer.from('content'));
    expect(snap.path).toBe('memories/daily/2026-08-29.md');
    expect(snap.sha256).toHaveLength(64);
    expect(snap.kind).toBe('memory');
  });

  it('rejects ineligible path', async () => {
    await expect(snapshotFile('profiles/x', Buffer.from(''))).rejects.toThrow();
  });

  it('identifies jsonl and session kinds', async () => {
    const j = await snapshotFile('memories/SUGGESTIONS.jsonl', Buffer.from('[]'));
    expect(j.kind).toBe('jsonl');
    const s = await snapshotFile('sessions/abc/def/session.jsonl.zstd', Buffer.from([0xfd, 0x2f, 0xb5, 0x28]));
    expect(s.kind).toBe('session');
  });
});
