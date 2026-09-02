// tests/remote-cache.spec.ts — remote fingerprint cache (fp.tsv) contract.
// The cache is a pure speed hint on the REMOTE side: the manifest script reads
// it (never writes), and only the warm script (run by push-apply or a warm
// command) refreshes it atomically. Guard = ino+size+mtimeNs+ctimeNs, same
// class as the local index.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseFpCache, buildWarmCacheScript, REMOTE_CACHE_REL } from '../src/host/remote-cache.js';
import { buildRemoteManifestScript, parseRemoteManifest } from '../src/host/remote-manifest.js';

describe('remote fingerprint cache', () => {
  it('parses TSV fp.tsv entries (rel, ino, size, mtimeNs, ctimeNs, sha256)', () => {
    const buf = Buffer.from(
      'memories/daily/a.md\t123\t100\t1700000000.123456789\t1700000000.123456789\t' + 'a'.repeat(64) + '\n' +
      'sessions/abc/def/session.jsonl.zstd\t9\t99\t1700000001.000000000\t1700000001.000000000\t' + 'b'.repeat(64) + '\n',
      'utf-8',
    );
    const m = parseFpCache(buf);
    const e = m.get('memories/daily/a.md')!;
    expect(e.ino).toBe(123);
    expect(e.size).toBe(100);
    expect(e.mtimeNs).toBe('1700000000.123456789');
    expect(e.ctimeNs).toBe('1700000000.123456789');
    expect(e.sha256).toBe('a'.repeat(64));
    expect(m.get('sessions/abc/def/session.jsonl.zstd')!.sha256).toBe('b'.repeat(64));
    // ineligible lines never parse
    const bad = parseFpCache(Buffer.from('settings.json\t1\t1\t1.0\t1.0\tzz\n', 'utf-8'));
    expect(bad.has('settings.json')).toBe(false);
  });

  it('warm script writes fp.tsv atomically (tmp + mv) and never uses shell interpolation of paths', () => {
    const s = buildWarmCacheScript('/home/kai/.dsh');
    expect(s).toContain(REMOTE_CACHE_REL);
    expect(s).toContain('.tmp.');
    expect(s).toMatch(/mv .*\.tmp\./);
  });

  it('manifest script is cache-aware but read-only: references the cache and never writes', () => {
    const s = buildRemoteManifestScript('/home/kai/.dsh');
    expect(s).toContain(REMOTE_CACHE_REL);       // reads the cache
    expect(s).not.toMatch(/\bmv\b/);             // no rename
    expect(s).not.toMatch(/mv\s/);                // no rename
    expect(s).not.toContain('.tmp.');              // no tmp-file staging
    expect(s).not.toMatch(new RegExp('>\\s*' + REMOTE_CACHE_REL.replace(/\//g, '\\/'))); // never writes the cache
  });

  it('executes under bash against a real temp root: cached files skip hashing, changed files re-hash', () => {
    const bash = spawnSync('bash', ['--version']);
    const isLinuxGnu = process.platform === 'linux' && bash.status === 0 && fs.existsSync('/usr/bin/stat');
    if (!isLinuxGnu) return; // needs GNU stat + bash
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-'));
    try {
      fs.mkdirSync(path.join(root, 'memories', 'daily'), { recursive: true });
      const a = path.join(root, 'memories', 'daily', 'a.md');
      fs.writeFileSync(a, 'same-bytes');
      const b = path.join(root, 'memories', 'daily', 'b.md');
      fs.writeFileSync(b, 'other-bytes');
      // seed a cache holding a WRONG sha for a.md but EXACT GNU-stat triple → must be trusted (hint)
      const stA = spawnSync('stat', ['-c', '%i %s %.Y %.Z', a], { encoding: 'utf-8' }).stdout.trim();
      const cacheDir = path.join(root, '.maestro-sync');
      fs.mkdirSync(cacheDir, { recursive: true });
      const wrongSha = 'f'.repeat(64);
      const cacheLine = `memories/daily/a.md\t${stA.split(' ').join('\t')}\t${wrongSha}\n`;
      fs.writeFileSync(path.join(cacheDir, 'fp.tsv'), cacheLine);

      const script = buildRemoteManifestScript(root);
      const res = spawnSync('bash', ['-c', script], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' });
      expect(res.status).toBe(0);
      const entries = parseRemoteManifest(Buffer.from(res.stdout, 'utf-8'));
      const aEntry = entries.find((e) => e.path === 'memories/daily/a.md');
      expect(aEntry!.sha256).toBe(wrongSha);       // cache match used, sha256sum skipped
      const bEntry = entries.find((e) => e.path === 'memories/daily/b.md');
      expect(bEntry!.sha256).toBe(require('node:crypto').createHash('sha256').update('other-bytes').digest('hex')); // miss → real hash
      // and the cache file was NOT modified by the read-only pass
      expect(fs.readFileSync(path.join(cacheDir, 'fp.tsv'), 'utf-8')).toBe(cacheLine);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});