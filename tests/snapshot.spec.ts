import { describe, it, expect } from 'vitest';
import { hashBuffer, snapshotFile, kindForPath, collectSnapshots, snapshotFromMap } from '../src/host/snapshot.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

describe('snapshot', () => {
  it('hashes buffer deterministically with SHA-256', async () => {
    const buf = Buffer.from('hello');
    expect(hashBuffer(buf)).toBe(hashBuffer(Buffer.from('hello')));
    expect(hashBuffer(buf)).not.toBe(hashBuffer(Buffer.from('world')));
    expect(hashBuffer(buf)).toHaveLength(64);
    expect(hashBuffer(Buffer.alloc(0))).toHaveLength(64);
  });

  it('creates snapshot for eligible memory path', async () => {
    const snap = await snapshotFile('memories/daily/2026-08-29.md', Buffer.from('content'));
    expect(snap.path).toBe('memories/daily/2026-08-29.md');
    expect(snap.sha256).toHaveLength(64);
    expect(snap.kind).toBe('memory');
    expect(snap.size).toBe(7);
  });

  it('rejects ineligible path', async () => {
    expect(() => snapshotFile('profiles/x', Buffer.from(''))).toThrow();
    expect(() => snapshotFile('../x', Buffer.from(''))).toThrow();
    expect(() => snapshotFile('memories/a\u0000.md', Buffer.from(''))).toThrow();
  });

  it('identifies jsonl and session kinds via kindForPath', async () => {
    expect(kindForPath('memories/SUGGESTIONS.jsonl')).toBe('jsonl');
    expect(kindForPath('memories/daily/2026-08-29.md')).toBe('memory');
    expect(kindForPath('sessions/abc123/def456/session.jsonl.zstd')).toBe('session');
    const j = await snapshotFile('memories/SUGGESTIONS.jsonl', Buffer.from('[]'));
    expect(j.kind).toBe('jsonl');
    const s = await snapshotFile('sessions/abc123/def456/session.jsonl.zstd', Buffer.from([0xfd, 0x2f, 0xb5, 0x28]));
    expect(s.kind).toBe('session');
  });

  it('collects only eligible files from a directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    try {
      const memDir = path.join(tmp, 'memories', 'daily');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, '2026-08-29.md'), 'hello');
      fs.writeFileSync(path.join(tmp, 'memories', 'SUGGESTIONS.jsonl'), '{"a":1}\n');
      // ineligible: should be ignored
      fs.mkdirSync(path.join(tmp, 'profiles'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'profiles', 'x.md'), 'ignore');
      fs.mkdirSync(path.join(tmp, '.supervisor'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.supervisor', 'log.md'), 'ignore');

      const snaps = collectSnapshots(tmp, fs);
      const paths = snaps.map((s) => s.path);
      expect(paths).toContain('memories/daily/2026-08-29.md');
      expect(paths).toContain('memories/SUGGESTIONS.jsonl');
      expect(paths).not.toContain('profiles/x.md');
      expect(paths).not.toContain('.supervisor/log.md');
      expect(snaps.every((s) => s.sha256.length === 64)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('snapshotFromMap hashes validated paths only', async () => {
    const m = new Map<string, Buffer>([
      ['memories/daily/2026-08-29.md', Buffer.from('a')],
      ['profiles/x', Buffer.from('bad')],
    ]);
    const snaps = snapshotFromMap(m);
    expect(snaps.map((s) => s.path)).toEqual(['memories/daily/2026-08-29.md']);
  });
});
