/**
 * Preview persistence across processes (RED — caught by live CLI validation).
 *
 * The CLI contract is two processes: `cli --pull --dry-run` (process A) then
 * `cli --pull --apply --preview-id ID --confirm` (process B). The preview store
 * was in-memory per process, so a fresh process could never apply its own
 * preview (always STALE_PREVIEW). The store must persist to a sidecar dir that
 * both processes derive from DSH_HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SyncService } from '../src/host/sync-service.js';
import { clearPreviews, clearPreviewStore, getPreview } from '../src/host/sync-plan.js';
import { createFakeRemote, sha256, makeTempRoots } from './helpers/fake-transport.js';

const MD = 'memories/daily/2026-08-29.md';

const stubRunner: any = { run: async () => ({ stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), exitCode: 0 }) };

let previewDir = '';

beforeEach(() => {
  clearPreviews();
  previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-preview-store-'));
});

afterEach(() => {
  clearPreviewStore(previewDir);
  try {
    fs.rmSync(previewDir, { recursive: true, force: true });
  } catch {}
});

describe('preview persistence', () => {
  it('a preview stored by one process can be applied by a fresh process (same DSH_HOME dir)', async () => {
    const { localRoot, cleanup } = makeTempRoots('pp-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nlocal1\n');
      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nlocal1\n§\nremote2\n')]]));

      // process A: preview (in-memory + persisted to previewDir)
      const svcA = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        previewDir,
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });
      const preview = await svcA.preview({ direction: 'pull' });

      // simulate process B: fresh instance, fresh in-memory maps, same previewDir
      clearPreviews();
      const svcB = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        previewDir,
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });
      expect(getPreview(preview.previewId)).toBeUndefined(); // not in B's memory yet
      const result = await svcB.apply({ previewId: preview.previewId, direction: 'pull', confirm: true });
      expect(result.ok).toBe(true);
      expect(result.committed).toContain(MD);
      expect(fs.readFileSync(path.join(localRoot, MD), 'utf-8')).toBe('a\n§\nlocal1\n§\nremote2\n');
      // single-use persists across processes: a third apply rejects
      clearPreviews();
      const svcC = new SyncService({ localDsh: localRoot, remote: 'sync-host', remoteDsh: '/home/kai/.dsh', previewDir, fs: fs as any, runner: stubRunner as any, transport: createFakeRemote(new Map([[MD, Buffer.from('x')]])).transport as any });
      await expect(svcC.apply({ previewId: preview.previewId, direction: 'pull', confirm: true })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    } finally {
      cleanup();
    }
  });

  it('an expired persisted preview is rejected and cleaned up', async () => {
    const { localRoot, cleanup } = makeTempRoots('pp-exp-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n');
      const fake = createFakeRemote();
      const svc = new SyncService({ localDsh: localRoot, remote: 'sync-host', remoteDsh: '/home/kai/.dsh', previewDir, fs: fs as any, runner: stubRunner as any, transport: fake.transport as any });
      const preview = await svc.preview({ direction: 'pull' });
      const file = path.join(previewDir, `${preview.previewId}.json`);
      expect(fs.existsSync(file)).toBe(true);
      // force expiry in the file (persisted shape is { preview, direction })
      const rec = JSON.parse(fs.readFileSync(file, 'utf-8'));
      rec.preview.expiresAt = new Date(Date.now() - 1000).toISOString();
      fs.writeFileSync(file, JSON.stringify(rec), 'utf-8');
      clearPreviews();
      const svcB = new SyncService({ localDsh: localRoot, remote: 'sync-host', remoteDsh: '/home/kai/.dsh', previewDir, fs: fs as any, runner: stubRunner as any, transport: fake.transport as any });
      await expect(svcB.apply({ previewId: preview.previewId, direction: 'pull', confirm: true })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
      expect(fs.existsSync(file)).toBe(false); // expired file cleaned
      // hash equality sanity for the fixture line above
      expect(sha256(Buffer.from('a\n'))).toHaveLength(64);
    } finally {
      cleanup();
    }
  });
});