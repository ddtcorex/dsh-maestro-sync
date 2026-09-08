import { describe, it, expect } from 'vitest';
import { validateRemoteTarget, normalizeEligiblePath, HOST_RE, ABSOLUTE_RE, ELIGIBLE_RE } from '../src/host/validation.js';

describe('validation', () => {
  describe('HOST regex', () => {
    it('matches valid hosts', () => {
      expect(HOST_RE.test('sync-host')).toBe(true);
      expect(HOST_RE.test('kai@ssh.ddtcorex.com')).toBe(true);
      expect(HOST_RE.test('host:2222')).toBe(true);
      expect(HOST_RE.test('192.168.1.1')).toBe(true);
      expect(HOST_RE.test('dsh-remote')).toBe(true);
    });
    it('rejects hosts starting with -', () => {
      expect(HOST_RE.test('-oProxyCommand=x')).toBe(false);
      expect(HOST_RE.test('-host')).toBe(false);
    });
  });

  describe('ABSOLUTE regex', () => {
    it('matches absolute paths', () => {
      expect(ABSOLUTE_RE.test('/home/kai/.dsh')).toBe(true);
      expect(ABSOLUTE_RE.test('/tmp/a')).toBe(true);
      expect(ABSOLUTE_RE.test('/a')).toBe(true);
      expect(ABSOLUTE_RE.test('/home/kai/dsh-data')).toBe(true);
    });
    it('rejects non-absolute and unsafe', () => {
      expect(ABSOLUTE_RE.test('~/.dsh')).toBe(false);
      expect(ABSOLUTE_RE.test('/')).toBe(false);
      expect(ABSOLUTE_RE.test('../dsh')).toBe(false);
      expect(ABSOLUTE_RE.test('/tmp/a;id')).toBe(false);
      expect(ABSOLUTE_RE.test('/tmp/a\nnext')).toBe(false);
    });
  });

  describe('ELIGIBLE regex', () => {
    it('matches eligible paths', () => {
      expect(ELIGIBLE_RE.test('dsh-maestro-memory/daily/2026-08-29.md')).toBe(true);
      expect(ELIGIBLE_RE.test('dsh-maestro-memory/SUGGESTIONS.jsonl')).toBe(true);
      expect(ELIGIBLE_RE.test('sessions/abc123/def456/session.jsonl.zstd')).toBe(true);
      expect(ELIGIBLE_RE.test('dsh-maestro-memory/projects/foo.md')).toBe(true);
    });
    it('rejects ineligible', () => {
      expect(ELIGIBLE_RE.test('../x')).toBe(false);
      expect(ELIGIBLE_RE.test('dsh-maestro-memory/a\u0000.md')).toBe(false);
      expect(ELIGIBLE_RE.test('profiles/x')).toBe(false);
      expect(ELIGIBLE_RE.test('dsh-maestro-memory/a.bak.md')).toBe(false);
      expect(ELIGIBLE_RE.test('dsh-maestro-memory/foo.bak.bar.md')).toBe(false);
    });
  });

  describe('renamed memory root (dsh-maestro-memory)', () => {
    it('matches eligible paths under the new root', () => {
      expect(ELIGIBLE_RE.test('dsh-maestro-memory/daily/2026-09-08.md')).toBe(true);
      expect(ELIGIBLE_RE.test('dsh-maestro-memory/SUGGESTIONS.jsonl')).toBe(true);
      expect(ELIGIBLE_RE.test('dsh-maestro-memory/projects/foo.md')).toBe(true);
    });
    it('normalizes paths under the new root', () => {
      expect(normalizeEligiblePath('dsh-maestro-memory/daily/2026-09-08.md')).toBe(
        'dsh-maestro-memory/daily/2026-09-08.md',
      );
    });
    it('rejects the legacy memories/ root', () => {
      expect(ELIGIBLE_RE.test('memories/daily/2026-09-08.md')).toBe(false);
      expect(() => normalizeEligiblePath('memories/daily/2026-09-08.md')).toThrow();
    });
  });

  describe('validateRemoteTarget', () => {
    it.each(['~/.dsh', '/', '../dsh', '/tmp/a;id', '/tmp/a\nnext'])('rejects unsafe remote root %s', (root) => {
      expect(() => validateRemoteTarget({ host: 'sync-host', dshRoot: root })).toThrow();
    });

    it.each(['-oProxyCommand=x', 'host;id', 'host name'])('rejects unsafe host %s', (host) => {
      expect(() => validateRemoteTarget({ host, dshRoot: '/home/kai/.dsh' })).toThrow();
    });

    it('accepts valid remote target', () => {
      expect(validateRemoteTarget({ host: 'sync-host', dshRoot: '/home/kai/.dsh' })).toEqual({
        host: 'sync-host',
        dshRoot: '/home/kai/.dsh',
      });
      expect(validateRemoteTarget({ host: 'kai@ssh.ddtcorex.com', dshRoot: '/home/kai/.dsh' })).toEqual({
        host: 'kai@ssh.ddtcorex.com',
        dshRoot: '/home/kai/.dsh',
      });
    });

    it('rejects empty and control chars', () => {
      expect(() => validateRemoteTarget({ host: '', dshRoot: '/home/kai/.dsh' })).toThrow();
      expect(() => validateRemoteTarget({ host: 'sync-host', dshRoot: '' })).toThrow();
      expect(() => validateRemoteTarget({ host: 'host\u0000name', dshRoot: '/home/kai/.dsh' })).toThrow();
      expect(() => validateRemoteTarget({ host: 'sync-host', dshRoot: '/tmp/a\u0000b' })).toThrow();
    });

    it('rejects traversal and tilde', () => {
      expect(() => validateRemoteTarget({ host: 'sync-host', dshRoot: '~/dsh' })).toThrow();
      expect(() => validateRemoteTarget({ host: 'sync-host', dshRoot: '/home/../etc' })).toThrow();
    });
  });

  describe('normalizeEligiblePath', () => {
    it.each(['../x', 'dsh-maestro-memory/a\u0000.md', 'profiles/x'])('rejects ineligible path %s', (p) => {
      expect(() => normalizeEligiblePath(p)).toThrow();
    });

    it('accepts eligible memory and session paths', () => {
      expect(normalizeEligiblePath('dsh-maestro-memory/daily/2026-08-29.md')).toBe('dsh-maestro-memory/daily/2026-08-29.md');
      expect(normalizeEligiblePath('dsh-maestro-memory/SUGGESTIONS.jsonl')).toBe('dsh-maestro-memory/SUGGESTIONS.jsonl');
      expect(normalizeEligiblePath('sessions/abc123/def456/session.jsonl.zstd')).toBe(
        'sessions/abc123/def456/session.jsonl.zstd',
      );
    });

    it('rejects bak files, absolute, and session non-canonical', () => {
      expect(() => normalizeEligiblePath('dsh-maestro-memory/foo.bak.md')).toThrow();
      expect(() => normalizeEligiblePath('dsh-maestro-memory/a.bak./b.md')).toThrow();
      expect(() => normalizeEligiblePath('/dsh-maestro-memory/a.md')).toThrow();
      expect(() => normalizeEligiblePath('sessions/a/b/bad.jsonl')).toThrow();
      expect(() => normalizeEligiblePath('dsh-maestro-memory/a.txt')).toThrow();
    });

    it('rejects control chars and traversal', () => {
      expect(() => normalizeEligiblePath('dsh-maestro-memory/a\n.md')).toThrow();
      expect(() => normalizeEligiblePath('dsh-maestro-memory/../a.md')).toThrow();
      expect(() => normalizeEligiblePath('')).toThrow();
    });
  });
});
