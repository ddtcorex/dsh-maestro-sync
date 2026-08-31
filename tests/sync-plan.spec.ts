import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPlan, buildPreview, clearPreviews, revisionFrom } from '../src/host/sync-plan.js';
import { SyncService } from '../src/host/sync-service.js';
import type { FileSnapshot } from '../src/host/sync-types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('sync-plan', () => {
  beforeEach(() => clearPreviews());

  it('marks same-name unequal content as merge and computes the real added count', async () => {
    const localSnap: FileSnapshot = { path: 'memories/daily/2026-08-29.md', sha256: 'aaa', size: 10, kind: 'memory' };
    const remoteSnap: FileSnapshot = { path: 'memories/daily/2026-08-29.md', sha256: 'bbb', size: 12, kind: 'memory' };
    // local has 'a § foo', remote has 'a § foo § bar' => merge adds 1
    const localContents = new Map([['memories/daily/2026-08-29.md', Buffer.from('a\n§\nfoo\n')]]);
    const remoteContents = new Map([['memories/daily/2026-08-29.md', Buffer.from('a\n§\nfoo\n§\nbar\n')]]);
    const preview = await buildPlan([localSnap], [remoteSnap], 'pull', localContents, remoteContents);
    expect(preview.actions).toContainEqual(expect.objectContaining({ path: 'memories/daily/2026-08-29.md', action: 'merge', added: 1 }));
    expect(preview.summary.merged).toBe(1);
    expect(preview.summary.added).toBe(1);
  });

  it('skips identical bytes even when mtime differs', async () => {
    const snap: FileSnapshot = { path: 'memories/a.md', sha256: 'same', size: 5, kind: 'memory' };
    const buf = Buffer.from('hi');
    const plan = await buildPlan([snap], [snap], 'pull', new Map([['memories/a.md', buf]]), new Map([['memories/a.md', buf]]));
    expect(plan.summary.skipped).toBe(1);
    expect(plan.actions[0].action).toBe('skip');
    expect(plan.actions[0].reason).toMatch(/identical/);
  });

  it('dispatches markdown to mergeDelimited, jsonl to exact-line union', async () => {
    const mdLocal: FileSnapshot = { path: 'memories/daily/2026-08-30.md', sha256: 'l1', size: 5, kind: 'memory' };
    const mdRemote: FileSnapshot = { path: 'memories/daily/2026-08-30.md', sha256: 'r1', size: 6, kind: 'memory' };
    const jsonlLocal: FileSnapshot = { path: 'memories/SUGGESTIONS.jsonl', sha256: 'l2', size: 5, kind: 'jsonl' };
    const jsonlRemote: FileSnapshot = { path: 'memories/SUGGESTIONS.jsonl', sha256: 'r2', size: 6, kind: 'jsonl' };
    const localContents = new Map<string, Buffer>([
      ['memories/daily/2026-08-30.md', Buffer.from('x\n§\ny\n')],
      ['memories/SUGGESTIONS.jsonl', Buffer.from('{"a":1}\n')],
    ]);
    const remoteContents = new Map<string, Buffer>([
      ['memories/daily/2026-08-30.md', Buffer.from('x\n§\ny\n§\nz\n')],
      ['memories/SUGGESTIONS.jsonl', Buffer.from('{"a":1}\n{"b":2}\n')],
    ]);
    const plan = await buildPlan([mdLocal, jsonlLocal], [mdRemote, jsonlRemote], 'pull', localContents, remoteContents);
    const mdAct = plan.actions.find((a) => a.path === 'memories/daily/2026-08-30.md');
    const jsonlAct = plan.actions.find((a) => a.path === 'memories/SUGGESTIONS.jsonl');
    expect(mdAct?.action).toBe('merge');
    expect(mdAct?.added).toBe(1);
    expect(jsonlAct?.action).toBe('merge');
    expect(jsonlAct?.added).toBe(1);
  });

  it('buildPreview stores bounded 60s preview with opaque ID and revision from snapshots+direction', async () => {
    clearPreviews();
    const snap: FileSnapshot = { path: 'memories/a.md', sha256: 'same', size: 5, kind: 'memory' };
    const preview = await buildPreview([snap], [snap], 'pull', new Map(), new Map());
    expect(preview.previewId).toMatch(/^[0-9a-f]{16,}$/);
    expect(preview.expiresAt).toBeDefined();
    const expiresMs = new Date(preview.expiresAt).getTime() - Date.now();
    expect(expiresMs).toBeGreaterThan(50000);
    expect(expiresMs).toBeLessThanOrEqual(61000);
    expect(preview.revision).toBe(revisionFrom([snap, snap], 'pull'));
    // revision differs by direction
    const previewPush = await buildPreview([snap], [snap], 'push', new Map(), new Map());
    expect(previewPush.revision).not.toBe(preview.revision);
  });

  it('copies remote-only for pull and skips for push', async () => {
    const remoteSnap: FileSnapshot = { path: 'memories/new.md', sha256: 'new', size: 5, kind: 'memory' };
    const pull = await buildPlan([], [remoteSnap], 'pull', new Map(), new Map([['memories/new.md', Buffer.from('hi')]]));
    expect(pull.actions[0].action).toBe('copy');
    expect(pull.summary.copied).toBe(1);
    const push = await buildPlan([], [remoteSnap], 'push', new Map(), new Map([['memories/new.md', Buffer.from('hi')]]));
    expect(push.actions[0].action).toBe('skip');
  });

  it('preview via SyncService marks merge and skip correctly (read-only, no copy/backup)', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (String(cmd).includes('echo ok')) return 'ok';
      if (String(cmd).includes('find')) return 'memories/daily/2026-08-29.md\nmemories/shared.md\n';
      return '';
    });
    // mock fs for local files
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-preview-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'daily', '2026-08-29.md'), 'a\n§\nfoo\n');
      fs.writeFileSync(path.join(localRoot, 'memories', 'shared.md'), 'identical\n');

      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      // spy fetchRemoteFile to return remote contents: daily has extra entry, shared identical
      vi.spyOn(svc as any, 'fetchRemoteFile').mockImplementation(async (p: string) => {
        if (p === 'memories/daily/2026-08-29.md') return 'a\n§\nfoo\n§\nbar\n';
        if (p === 'memories/shared.md') return 'identical\n';
        return '';
      });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 });
      // spy list methods to return filtered
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/daily/2026-08-29.md', 'memories/shared.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/daily/2026-08-29.md', 'memories/shared.md']);

      // ensure copy not called
      const copySpy = vi.fn();
      (svc as any).copyRemoteFiles = copySpy;
      const backupSpy = vi.fn();
      (svc as any).atomicWriteWithBackup = backupSpy;

      const preview = await svc.preview({ direction: 'pull' });
      expect(preview.actions).toContainEqual(expect.objectContaining({ path: 'memories/daily/2026-08-29.md', action: 'merge', added: 1 }));
      expect(preview.summary.skipped).toBe(1);
      const skip = preview.actions.find((a: any) => a.path === 'memories/shared.md');
      expect(skip?.action).toBe('skip');
      // preview must not have called copy/backup
      expect(copySpy).not.toHaveBeenCalled();
      expect(backupSpy).not.toHaveBeenCalled();
      // previewId and expires
      expect(preview.previewId).toBeDefined();
      expect(preview.revision).toBeDefined();
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('skips identical bytes even when mtime differs via service preview', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (String(cmd).includes('echo ok')) return 'ok';
      if (String(cmd).includes('find')) return 'memories/a.md\n';
      return '';
    });
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-skip-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'a.md'), 'same content');
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 });
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/a.md']);
      vi.spyOn(svc as any, 'fetchRemoteFile').mockResolvedValue('same content');
      const preview = await svc.preview({ direction: 'pull' });
      expect(preview.summary.skipped).toBe(1);
      expect(preview.actions[0].action).toBe('skip');
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });
});
