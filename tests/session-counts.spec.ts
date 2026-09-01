import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SyncService } from '../src/host/sync-service.js';
import { clearPreviews } from '../src/host/sync-plan.js';
import { createFakeRemote, makeTempRoots } from './helpers/fake-transport.js';

const MD = 'memories/daily/2026-08-29.md';
const S1 = 'sessions/abc123/one/session.jsonl.zstd';
const S2 = 'sessions/abc123/two/session.jsonl.zstd';
const S3 = 'sessions/abc123/three/session.jsonl.zstd';

const stubRunner: any = {
  run: vi.fn(async () => ({ stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), exitCode: 0 })),
};

function makeService(localRoot: string, fake: ReturnType<typeof createFakeRemote>) {
  return new SyncService({
    localDsh: localRoot,
    remote: 'sync-host',
    remoteDsh: '/home/kai/.dsh',
    fs: fs as any,
    runner: stubRunner as any,
    transport: fake.transport as any,
  });
}

describe('count-only session preview', () => {
  it('sessions are counted by checksum without staging remote bytes; md files still get exact actions', async () => {
    const { localRoot, cleanup } = makeTempRoots('preview-count-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nfoo\n');
      // remote: S1 added (pull), S2 updated (checksum differs), S3 identical
      const fake = createFakeRemote(
        new Map([
          [MD, Buffer.from('a\n§\nfoo\n§\nbar\n')],
          [S1, Buffer.from('sess-one-a\n')],
          [S2, Buffer.from('sess-two-REMOTE\n')],
          [S3, Buffer.from('sess-three\n')],
        ]),
      );
      fs.mkdirSync(path.join(localRoot, 'sessions', 'abc123', 'two'), { recursive: true });
      fs.mkdirSync(path.join(localRoot, 'sessions', 'abc123', 'three'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, S2), 'sess-two-LOCAL\n');
      fs.writeFileSync(path.join(localRoot, S3), 'sess-three\n');

      const svc = makeService(localRoot, fake);
      const ticks: string[] = [];
      const preview = await svc.preview({
        direction: 'pull',
        sessionsCountOnly: true,
        onProgress: (p) => ticks.push(`${p.phase}:${p.current}/${p.total}${p.file ? ':' + p.file.split('/').pop() : ''}`),
      });

      // counts: S1 only-remote -> added; S2 differs -> updated; S3 identical
      expect(preview.sessionCounts).toEqual({ added: 1, updated: 1, deleted: 0, identical: 1 });
      // the session files never hit stage (they carry no content into the plan)
      expect(fake.calls.stage.length).toBeGreaterThan(0); // MD staged
      expect(fake.calls.stage.some((s: any) => s.paths.includes(S1) || s.paths.includes(S2))).toBe(false);
      // md still yields the exact merge action with added count
      const mdAction = preview.actions.find((a: any) => a.path === MD);
      expect(mdAction?.action).toBe('merge');
      expect(mdAction?.added).toBe(1);
      // no session rows in the action list (counted, not listed)
      expect(preview.actions.some((a: any) => a.path.endsWith('.jsonl.zstd'))).toBe(false);
      // progress included the hashing phase with per-file ticks
      expect(ticks.some((t) => t.startsWith('hashing:'))).toBe(true);
      expect(ticks.some((t) => t.includes('session.jsonl.zstd'))).toBe(true);
      // preview persisted for the apply step (same as the full preview path)
      const stored = await import('../src/host/sync-plan.js');
      expect(stored.getPreview(preview.previewId, svc['previewDir'])).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('a count-only preview revision equals a full-content apply revision for the same inventory', async () => {
    const { localRoot, cleanup } = makeTempRoots('preview-rev-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n');
      const fake = createFakeRemote(new Map([[S2, Buffer.from('sess-two-REMOTE\n')]]));
      fs.mkdirSync(path.join(localRoot, 'sessions', 'abc123', 'two'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, S2), 'sess-two-LOCAL\n');

      const svc = makeService(localRoot, fake);
      const countPreview = await svc.preview({ direction: 'pull', sessionsCountOnly: true });
      // apply succeeds end-to-end — the counted revision matched the apply
      // re-inventory (no STALE_PREVIEW). Session bytes here are fake (not
      // zstd), so their merge surfaces as a plan conflict, not a commit; the
      // point of this test is only that the count-only preview revision equals
      // the full-content apply revision for the same inventory.
      const fullApply = await svc.apply({ previewId: countPreview.previewId, direction: 'pull', confirm: true });
      expect(fullApply.ok).toBe(true);
      expect(fullApply.committed).not.toContain(undefined);
    } finally {
      cleanup();
    }
  });

  it('sessions that are identical are not re-transferred and show as identical', async () => {
    const { localRoot, cleanup } = makeTempRoots('preview-ident-');
    try {
      const fake = createFakeRemote(new Map([[S3, Buffer.from('sess-three\n')]]));
      fs.mkdirSync(path.join(localRoot, 'sessions', 'abc123', 'three'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, S3), 'sess-three\n');
      const svc = makeService(localRoot, fake);
      const preview = await svc.preview({ direction: 'pull', sessionsCountOnly: true });
      expect(preview.sessionCounts).toEqual({ added: 0, updated: 0, deleted: 0, identical: 1 });
      expect(fake.calls.stage.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});