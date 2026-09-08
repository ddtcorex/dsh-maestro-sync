// tests/remote-manifest.spec.ts
import { describe, it, expect } from 'vitest';
import { buildRemoteManifestScript, parseRemoteManifest } from '../src/host/remote-manifest.js';

describe('remote manifest', () => {
  it('parses NUL-framed sha<TAB>size<TAB>mtime<TAB>rel entries', () => {
    const frame = (rel: string, sha: string, size: number, mtime: number) =>
      Buffer.from(`${sha}\t${size}\t${mtime}\t${rel}\0`, 'utf-8');
    const buf = Buffer.concat([
      frame('dsh-maestro-memory/daily/2026-09-01.md', 'a'.repeat(64), 12, 1700000000),
      frame('dsh-maestro-memory/notes/inner-file.md', 'b'.repeat(64), 3, 1700000001),
      frame('sessions/abc/def/session.jsonl.zstd', 'c'.repeat(64), 99, 1700000002),
    ]);
    const out = parseRemoteManifest(buf);
    expect(out.map((e) => e.path)).toEqual([
      'dsh-maestro-memory/daily/2026-09-01.md',
      'dsh-maestro-memory/notes/inner-file.md',
      'sessions/abc/def/session.jsonl.zstd',
    ]);
    expect(out[0]!.sha256).toBe('a'.repeat(64));
    expect(out[0]!.size).toBe(12);
  });

  it('rejects ineligible and unsafe paths (settings, traversal, spaces, newlines in name)', () => {
    const buf = Buffer.concat([
      Buffer.from(`${'0'.repeat(64)}\t1\t1\tsettings.json\0`, 'utf-8'),
      Buffer.from(`${'0'.repeat(64)}\t1\t1\t../../etc/passwd\0`, 'utf-8'),
      Buffer.from(`${'0'.repeat(64)}\t1\t1\tdsh-maestro-memory/notes/space name.md\0`, 'utf-8'), // eligibility forbids whitespace
      Buffer.from(`${'0'.repeat(64)}\t1\t1\tdsh-maestro-memory/notes/bad\nname.md\0`, 'utf-8'), // control char
      Buffer.from(`${'0'.repeat(64)}\t1\t1\tdsh-maestro-memory/ok.md\0`, 'utf-8'),
    ]);
    const out = parseRemoteManifest(buf);
    expect(out.map((e) => e.path)).toEqual(['dsh-maestro-memory/ok.md']);
  });

  it('buildRemoteManifestScript embeds only the validated absolute root', () => {
    const s = buildRemoteManifestScript('/home/kai/.dsh');
    expect(s).toContain('/home/kai/.dsh/dsh-maestro-memory');
    expect(s).toContain('sha256sum');
    expect(s).toContain('printf');
  });
});