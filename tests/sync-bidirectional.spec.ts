import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SyncService } from '../src/host/sync-service.js';
import { clearPreviews } from '../src/host/sync-plan.js';
import { createFakeRemote, makeTempRoots } from './helpers/fake-transport.js';
import { makeSessionBuffer, sessionHeader } from './helpers/zstd.js';

const MD = 'dsh-maestro-memory/daily/2026-09-09.md';
const SESSION = 'sessions/abc123/def456/session.jsonl.zstd';

const stubRunner: any = {
  run: vi.fn(async () => ({ stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), exitCode: 0 })),
};

function makeSvc(localRoot: string, fake: any) {
  return new SyncService({
    localDsh: localRoot,
    remote: 'sync-host',
    remoteDsh: '/home/kai/.dsh',
    fs: fs as any,
    runner: stubRunner as any,
    transport: fake.transport as any,
  });
}

beforeEach(() => clearPreviews());

describe('bidirectional orchestration', () => {
  const summaries = {
    work: { copied: 1, merged: 1, skipped: 0, conflicts: 0, added: 3 },
    converged: { copied: 0, merged: 0, skipped: 5, conflicts: 0, added: 0 },
  };

  function stubService(behavior: { pushOk: boolean }) {
    const calls: string[] = [];
    const svc = {
      preview: async ({ direction }: any) => {
        calls.push(`preview:${direction}`);
        return {
          previewId: `pv-${direction}-${calls.length}`,
          revision: 'r',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          summary: direction === 'pull' && calls.filter((c) => c === 'preview:pull').length > 1 ? summaries.converged : summaries.work,
          actions: [],
        };
      },
      apply: async ({ direction }: any) => {
        calls.push(`apply:${direction}`);
        if (direction === 'push' && !behavior.pushOk) {
          return { ok: false, revision: 'r', summary: summaries.work, committed: [], failures: [{ phase: 'publish', code: 'PUBLISH_FAILED', detail: 'boom' }] };
        }
        return { ok: true, revision: 'r', summary: summaries.work, committed: [`file-${direction}.md`], failures: [] };
      },
    } as any;
    return { svc, calls };
  }

  it('apply runs push first, then pull, then verifies convergence', async () => {
    const { runBidirectionalApply } = await import('../src/host/bidirectional.js');
    const { svc, calls } = stubService({ pushOk: true });
    const r = await runBidirectionalApply(svc, { previewId: 'pv', confirm: true as const, scope: 'memory' });
    expect(calls).toEqual(['apply:push', 'preview:pull', 'apply:pull', 'preview:pull']);
    expect(r.ok).toBe(true);
    expect(r.pull).not.toBeNull();
    expect(r.verification).toEqual(summaries.converged);
    expect(r.committed).toEqual(['file-push.md', 'file-pull.md']);
  });

  it('push failure skips pull entirely', async () => {
    const { runBidirectionalApply } = await import('../src/host/bidirectional.js');
    const { svc, calls } = stubService({ pushOk: false });
    const r = await runBidirectionalApply(svc, { previewId: 'pv', confirm: true as const, scope: 'memory' });
    expect(r.ok).toBe(false);
    expect(r.pull).toBeNull();
    expect(r.verification).toBeNull();
    expect(calls).toEqual(['apply:push']);
  });

  it('apply without confirm:true throws before any write', async () => {
    const { runBidirectionalApply } = await import('../src/host/bidirectional.js');
    const { svc, calls } = stubService({ pushOk: true });
    await expect(runBidirectionalApply(svc, { previewId: 'pv', confirm: false as any, scope: 'memory' })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(calls).toEqual([]);
  });

  it('preview returns exact push plus projected pull plans', async () => {
    const { runBidirectionalPreview } = await import('../src/host/bidirectional.js');
    const { svc, calls } = stubService({ pushOk: true });
    const p = await runBidirectionalPreview(svc, { scope: 'memory' });
    expect(calls).toEqual(['preview:push', 'preview:pull']);
    expect(p.push).toBeTruthy();
    expect(p.pullProjected).toBeTruthy();
    expect(p.previewId).toBe(p.push.previewId);
  });
});

describe('scope filter', () => {
  it("memory scope excludes sessions/ paths from the plan", async () => {
    const { localRoot, cleanup } = makeTempRoots('scope-memory-');
    try {
      fs.mkdirSync(path.join(localRoot, 'dsh-maestro-memory', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nlocal\n');
      const header = sessionHeader();
      fs.mkdirSync(path.join(localRoot, 'sessions', 'abc123', 'def456'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, SESSION), makeSessionBuffer(header, ['{"seq":0}']));
      const fake = createFakeRemote(
        new Map<string, Buffer>([
          [MD, Buffer.from('a\n§\nremote\n')],
          [SESSION, makeSessionBuffer(header, ['{"seq":0}', '{"seq":1}'])],
        ]),
      );
      const svc = makeSvc(localRoot, fake);

      const preview = await svc.preview({ direction: 'pull', scope: 'memory' });
      const paths = preview.actions.map((a: any) => a.path);
      expect(paths).toContain(MD);
      expect(paths.some((p: string) => p.startsWith('sessions/'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("all scope keeps sessions/ paths in the plan", async () => {
    const { localRoot, cleanup } = makeTempRoots('scope-all-');
    try {
      fs.mkdirSync(path.join(localRoot, 'dsh-maestro-memory', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nlocal\n');
      const header = sessionHeader();
      fs.mkdirSync(path.join(localRoot, 'sessions', 'abc123', 'def456'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, SESSION), makeSessionBuffer(header, ['{"seq":0}']));
      const fake = createFakeRemote(
        new Map<string, Buffer>([
          [MD, Buffer.from('a\n§\nremote\n')],
          [SESSION, makeSessionBuffer(header, ['{"seq":0}', '{"seq":1}'])],
        ]),
      );
      const svc = makeSvc(localRoot, fake);

      const preview = await svc.preview({ direction: 'pull', scope: 'all' });
      const paths = preview.actions.map((a: any) => a.path);
      expect(paths).toContain(MD);
      expect(paths).toContain(SESSION);
    } finally {
      cleanup();
    }
  });
});
