/**
 * Apply semantics — the plan's Task 5 contract:
 * - apply requires {previewId, direction, confirm:true}
 * - a changed inventory after preview is rejected as STALE_PREVIEW before any write
 * - pull publishes through backup + fsync + rename (never direct rsync into the live root)
 * - push materializes, uploads and commits through compare-and-swap (expectedTargetSha256)
 * - session artifacts are merged from raw staged bytes, never UTF-8-decoded
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SyncService } from '../src/host/sync-service.js';
import { clearPreviews } from '../src/host/sync-plan.js';
import { createFakeRemote, sha256, makeTempRoots } from './helpers/fake-transport.js';
import { makeSessionBuffer, sessionHeader, ZSTD_MAGIC } from './helpers/zstd.js';

const MD = 'memories/daily/2026-08-29.md';
const SESSION = 'sessions/abc123/def456/session.jsonl.zstd';

function makeFsProbe(): { fs: any; backupCreated: boolean; fsyncCalled: boolean; renameCalled: boolean } {
  const orig = fs as any;
  const probe: { fs: any; backupCreated: boolean; fsyncCalled: boolean; renameCalled: boolean } = {
    fs: {} as any,
    backupCreated: false,
    fsyncCalled: false,
    renameCalled: false,
  };
  probe.fs = {
    ...orig,
    copyFileSync: vi.fn((src: string, dest: string) => {
      if (String(dest).includes('.bak.')) probe.backupCreated = true;
      return orig.copyFileSync(src, dest);
    }),
    openSync: (...a: any[]) => orig.openSync(...a),
    fsyncSync: vi.fn((fd: number) => {
      probe.fsyncCalled = true;
      return orig.fsyncSync(fd);
    }),
    closeSync: vi.fn((fd: number) => orig.closeSync(fd)),
    renameSync: vi.fn((a: string, b: string) => {
      // atomic pattern: tmp file renamed over the final destination
      if (String(a).includes('.tmp.') && !String(b).includes('.tmp.')) probe.renameCalled = true;
      return orig.renameSync(a, b);
    }),
  };
  return probe;
}

const stubRunner: any = {
  run: vi.fn(async () => ({ stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), exitCode: 0 })),
};

beforeEach(() => clearPreviews());

describe('apply', () => {
  it('rejects a preview whose inventory changed since preview, before any write', async () => {
    const { localRoot, cleanup } = makeTempRoots('apply-stale-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      const localPath = path.join(localRoot, MD);
      fs.writeFileSync(localPath, 'a\n§\nlocal1\n');
      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nremote1\n')]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });

      const preview = await svc.preview({ direction: 'pull' });
      expect(preview.actions).toContainEqual(expect.objectContaining({ path: MD, action: 'merge' }));

      // Remote adds another entry between preview and apply.
      fake.remote.set(MD, Buffer.from('a\n§\nremote1\n§\nremote2\n'));

      await expect(svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: true })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
      // No local write happened.
      expect(fs.readFileSync(localPath, 'utf-8')).toBe('a\n§\nlocal1\n');
    } finally {
      cleanup();
    }
  });

  it('pull copy publishes through atomic local write, never a direct rsync into the live root', async () => {
    const { localRoot, cleanup } = makeTempRoots('apply-copy-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      const fake = createFakeRemote(
        new Map([
          [MD, Buffer.from('a\n§\nremote-only-day\n')],
          [SESSION, makeSessionBuffer(sessionHeader(), ['{"type":"turn/start","seq":0}'])],
        ]),
      );
      const probe = makeFsProbe();
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: probe.fs,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });

      // local has none of the remote files -> pull = two copy actions
      const preview = await svc.preview({ direction: 'pull' });
      expect(preview.actions.every((a: any) => a.action === 'copy')).toBe(true);

      const result = await svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: true });
      expect(result.ok).toBe(true);
      expect(result.committed).toContain(MD);
      expect(fs.readFileSync(path.join(localRoot, MD), 'utf-8')).toBe('a\n§\nremote-only-day\n');
      // md copy went through rename (materialize + atomic publish), not rsync into the live root.
      expect(probe.renameCalled).toBe(true);
      expect(probe.fsyncCalled).toBe(true);
      expect(fake.calls.stage.some((c) => c.dest === localRoot)).toBe(false);
      // session bytes are byte-identical after the pull.
      const pulledSession = fs.readFileSync(path.join(localRoot, SESSION));
      expect(pulledSession.readUInt32LE(0)).toBe(ZSTD_MAGIC);
      expect(pulledSession.equals(fake.remote.get(SESSION)!)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('push merge uploads and commit-CAS-publishes with the expected target SHA-256', async () => {
    const { localRoot, cleanup } = makeTempRoots('apply-push-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      const localPath = path.join(localRoot, MD);
      fs.writeFileSync(localPath, 'a\n§\nentry-local\n');
      const remoteBytes = Buffer.from('a\n§\nentry-remote\n');
      const fake = createFakeRemote(new Map([[MD, remoteBytes]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });

      const preview = await svc.preview({ direction: 'push' });
      const act = preview.actions.find((a: any) => a.path === MD)!;
      expect(act.action).toBe('merge');
      expect(act.expectedTargetSha256).toBe(sha256(remoteBytes));

      const result = await svc.apply({ previewId: preview.previewId, direction: 'push', confirm: true });
      expect(result.ok).toBe(true);
      expect(result.committed).toContain(MD);
      expect(fake.calls.upload.length).toBe(1);
      expect(fake.calls.commit.length).toBe(1);
      const manifest = JSON.parse(fake.calls.commit[0]!.manifest.toString('utf-8'));
      expect(manifest).toEqual({ path: MD, expected: sha256(remoteBytes) });
      // merged remote content contains both entries
      const remoteFinal = fake.remote.get(MD)!.toString('utf-8');
      expect(remoteFinal).toContain('entry-local');
      expect(remoteFinal).toContain('entry-remote');
    } finally {
      cleanup();
    }
  });

  it('push commit failure returns ok:false with committed/uncommitted journal', async () => {
    const { localRoot, cleanup } = makeTempRoots('apply-fail-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nentry-local\n');
      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nentry-remote\n')]]));
      fake.failNextCommitOnce = true;
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });

      const preview = await svc.preview({ direction: 'push' });
      const result = await svc.apply({ previewId: preview.previewId, direction: 'push', confirm: true });
      expect(result.ok).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.failures[0]!.phase).toBe('publish');
      expect(result.committed).not.toContain(MD);
      expect(result.summary).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('pull session merge is binary-safe and reports the exact added count', async () => {
    const { localRoot, cleanup } = makeTempRoots('apply-session-');
    try {
      const header = sessionHeader();
      fs.mkdirSync(path.join(localRoot, 'sessions', 'abc123', 'def456'), { recursive: true });
      const localBuf = makeSessionBuffer(header, ['{"type":"turn/start","seq":0}']);
      const remoteBuf = makeSessionBuffer(header, ['{"type":"turn/start","seq":0}', '{"type":"turn/end","seq":1}']);
      const localPath = path.join(localRoot, SESSION);
      fs.writeFileSync(localPath, localBuf);
      const fake = createFakeRemote(new Map([[SESSION, remoteBuf]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });

      const preview = await svc.preview({ direction: 'pull' });
      const act = preview.actions.find((a: any) => a.path === SESSION)!;
      expect(act.action).toBe('merge');
      expect(act.added).toBe(1);

      const result = await svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: true });
      expect(result.ok).toBe(true);
      const out = fs.readFileSync(localPath);
      expect(out.readUInt32LE(0)).toBe(ZSTD_MAGIC);
      // merged artifact shares the session identity and stays a valid buffer artifact
      const { parseSessionIdentity } = await import('../src/host/session-plan.js');
      expect(parseSessionIdentity(out).sessionId).toBe('sync-test');
      // remote source is byte-identical after apply
      expect(fake.remote.get(SESSION)!.equals(remoteBuf)).toBe(true);
    } finally {
      cleanup();
    }
  });
});