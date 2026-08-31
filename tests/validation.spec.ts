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
      expect(ELIGIBLE_RE.test('memories/daily/2026-08-29.md')).toBe(true);
      expect(ELIGIBLE_RE.test('memories/SUGGESTIONS.jsonl')).toBe(true);
      expect(ELIGIBLE_RE.test('sessions/abc123/def456/session.jsonl.zstd')).toBe(true);
      expect(ELIGIBLE_RE.test('memories/projects/foo.md')).toBe(true);
    });
    it('rejects ineligible', () => {
      expect(ELIGIBLE_RE.test('../x')).toBe(false);
      expect(ELIGIBLE_RE.test('memories/a\u0000.md')).toBe(false);
      expect(ELIGIBLE_RE.test('profiles/x')).toBe(false);
      expect(ELIGIBLE_RE.test('memories/a.bak.md')).toBe(false);
      expect(ELIGIBLE_RE.test('memories/foo.bak.bar.md')).toBe(false);
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
    it.each(['../x', 'memories/a\u0000.md', 'profiles/x'])('rejects ineligible path %s', (p) => {
      expect(() => normalizeEligiblePath(p)).toThrow();
    });

    it('accepts eligible memory and session paths', () => {
      expect(normalizeEligiblePath('memories/daily/2026-08-29.md')).toBe('memories/daily/2026-08-29.md');
      expect(normalizeEligiblePath('memories/SUGGESTIONS.jsonl')).toBe('memories/SUGGESTIONS.jsonl');
      expect(normalizeEligiblePath('sessions/abc123/def456/session.jsonl.zstd')).toBe(
        'sessions/abc123/def456/session.jsonl.zstd',
      );
    });

    it('rejects bak files, absolute, and session non-canonical', () => {
      expect(() => normalizeEligiblePath('memories/foo.bak.md')).toThrow();
      expect(() => normalizeEligiblePath('memories/a.bak./b.md')).toThrow();
      expect(() => normalizeEligiblePath('/memories/a.md')).toThrow();
      expect(() => normalizeEligiblePath('sessions/a/b/bad.jsonl')).toThrow();
      expect(() => normalizeEligiblePath('memories/a.txt')).toThrow();
    });

    it('rejects control chars and traversal', () => {
      expect(() => normalizeEligiblePath('memories/a\n.md')).toThrow();
      expect(() => normalizeEligiblePath('memories/../a.md')).toThrow();
      expect(() => normalizeEligiblePath('')).toThrow();
    });
  });
});
