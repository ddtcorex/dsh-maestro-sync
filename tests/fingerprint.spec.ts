// tests/fingerprint.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadIndex, saveIndex, probeIndex, matchesStat, statFingerprint, type FpEntry } from '../src/host/fingerprint.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
});

describe('fingerprint index', () => {
  it('save+load round-trips entries and is tolerant of a missing/corrupt index', () => {
    saveIndex(dir, { schema: 1, rootKey: 'r', entries: { 'memories/a.md': { dev: 1, ino: 2, size: 3, mtimeNs: '4', ctimeNs: '5', sha256: 'aa' } } });
    const loaded = loadIndex(dir);
    expect(loaded.entries['memories/a.md']!.sha256).toBe('aa');
    expect(loadIndex(path.join(dir, 'missing')).entries).toEqual({});
    fs.writeFileSync(path.join(dir, 'index.json'), 'not-json{');
    expect(loadIndex(dir).entries).toEqual({});
  });

  it('matchesStat is true only when dev+ino+size+mtimeNs+ctimeNs all match (ctime guard on same-size rewrite)', () => {
    const file = path.join(dir, 'memories', 'x.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'hello');
    const st1 = fs.statSync(file, { bigint: true });
    const entry: FpEntry = { ...statFingerprint(st1), sha256: 'x' };
    expect(matchesStat(entry, st1)).toBe(true);

    // same-size rewrite ('hello' -> 'HELLO'): ino/dev/size/mtime may match, ctime must change
    fs.writeFileSync(file, 'HELLO');
    const st2 = fs.statSync(file, { bigint: true });
    expect(matchesStat(entry, st2)).toBe(false);
  });

  it('probeIndex returns null for unknown paths', () => {
    expect(probeIndex('memories/x.md', { schema: 1, rootKey: 'r', entries: {} })).toBeNull();
  });
});