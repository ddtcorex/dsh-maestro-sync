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
