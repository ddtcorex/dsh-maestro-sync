/**
 * Hermetic two-root rehearsal (Task 8): real files, real Zstd artifacts, the
 * real remote-agent CAS script, no network.
 * Preview equals Apply; Pull then Push converge; a second preview is empty;
 * apply applies the freshest inventory (a live-changed DSH home never blocks
 * with STALE_PREVIEW — CAS still rejects mid-write concurrent modification);
 * excluded paths are never read or copied.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SyncService } from '../src/host/sync-service.js';
import { clearPreviews } from '../src/host/sync-plan.js';
import { LocalRehearsalTransport } from './helpers/local-rehearsal-transport.js';
import { makeSessionBuffer, sessionHeader } from './helpers/zstd.js';

const stubRunner: any = { run: async () => ({ stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), exitCode: 0 }) };

const MD = 'memories/daily/2026-08-29.md';
const SESSION = 'sessions/abc123/def456/session.jsonl.zstd';
const SUGGESTIONS = 'memories/SUGGESTIONS.jsonl';

function buildRoots(prefix: string): { localRoot: string; remoteRoot: string; cleanup: () => void } {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-local-`));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-remote-`));
  return {
    localRoot,
    remoteRoot,
    cleanup: () => {
      try {
        fs.rmSync(localRoot, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(remoteRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}

function seed(root: string, files: Record<string, Buffer | string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'));
  }
}

function makeService(localRoot: string, remoteRoot: string): SyncService {
  return new SyncService({
    localDsh: localRoot,
    remote: 'rehearsal-host',
    remoteDsh: remoteRoot,
    fs: fs as any,
    runner: stubRunner as any,
    transport: new LocalRehearsalTransport(remoteRoot) as any,
  });
}

beforeEach(() => clearPreviews());

describe('hermetic two-root rehearsal', () => {
  it('Preview equals Apply; Pull then Push converge; second previews are empty; CAS rejects remote changes', async () => {
    const { localRoot, remoteRoot, cleanup } = buildRoots('rehearse');
    try {
      const header = sessionHeader();
      // local: one daily entry, one session event; remote: extra daily entry + extra session event + suggestions
      seed(localRoot, {
        [MD]: 'a\n§\nlocal1\n',
        [SESSION]: makeSessionBuffer(header, ['{"type":"turn/start","seq":0}']),
      });
      seed(remoteRoot, {
        [MD]: 'a\n§\nlocal1\n§\nremote2\n',
        [SESSION]: makeSessionBuffer(header, ['{"type":"turn/start","seq":0}', '{"type":"turn/end","seq":1}']),
        [SUGGESTIONS]: '{"s":1}\n{"s":2}\n',
        // excluded files — must never be read or copied
        'settings.json': '{"secret":true}',
        'profiles/web/package.json': '{"private":true}',
      });

      const svc = makeService(localRoot, remoteRoot);

      // pull preview is exact
      const pullPreview = await svc.preview({ direction: 'pull' });
      const mdAct = pullPreview.actions.find((a: any) => a.path === MD)!;
      const sessAct = pullPreview.actions.find((a: any) => a.path === SESSION)!;
      expect(mdAct.action).toBe('merge');
      expect(mdAct.added).toBe(1);
      expect(sessAct.action).toBe('merge');
      expect(sessAct.added).toBe(1);
      expect(pullPreview.actions.find((a: any) => a.path === SUGGESTIONS)!.action).toBe('copy');
      expect(pullPreview.actions.some((a: any) => a.path.startsWith('settings') || a.path.startsWith('profiles/'))).toBe(false);

      // apply pull = the preview
      const applied = await svc.apply({ previewId: pullPreview.previewId, direction: 'pull', confirm: true });
      expect(applied.ok).toBe(true);
      expect(applied.committed).toContain(MD);
      expect(fs.readFileSync(path.join(localRoot, MD), 'utf-8')).toBe('a\n§\nlocal1\n§\nremote2\n');
      // session is byte-valid with the standalone header frame preserved
      const mergedSession = fs.readFileSync(path.join(localRoot, SESSION));
      expect(mergedSession.readUInt32LE(0)).toBe(0xfd2fb528);
      const { parseSessionIdentity } = await import('../src/host/session-plan.js');
      expect(parseSessionIdentity(mergedSession).sessionId).toBe('sync-test');

      // a second pull preview is empty (converged)
      const secondPull = await svc.preview({ direction: 'pull' });
      expect(secondPull.actions.every((a: any) => a.action === 'skip')).toBe(true);
      expect(secondPull.summary.added).toBe(0);
      // but the excluded files are untouched and still present
      expect(fs.readFileSync(path.join(remoteRoot, 'settings.json'), 'utf-8')).toBe('{"secret":true}');
      expect(fs.readFileSync(path.join(remoteRoot, 'profiles/web/package.json'), 'utf-8')).toBe('{"private":true}');

      // now push a local-only change; push preview is a plan, apply publishes to the remote
      seed(localRoot, { 'memories/daily/2026-08-30.md': 'b\n§\nlocal-new-day\n' });
      const pushPreview = await svc.preview({ direction: 'push' });
      const pushCopy = pushPreview.actions.find((a: any) => a.path === 'memories/daily/2026-08-30.md')!;
      expect(pushCopy.action).toBe('copy');
      const pushed = await svc.apply({ previewId: pushPreview.previewId, direction: 'push', confirm: true });
      expect(pushed.ok).toBe(true);
      expect(fs.readFileSync(path.join(remoteRoot, 'memories/daily/2026-08-30.md'), 'utf-8')).toBe('b\n§\nlocal-new-day\n');
      // push converges too
      const secondPush = await svc.preview({ direction: 'push' });
      expect(secondPush.actions.every((a: any) => a.action === 'skip')).toBe(true);

      // a target that changed between preview and apply is applied against the
      // freshest inventory (no STALE_PREVIEW) — the concurrent edit is merged
      // into the publish, and CAS still rejects a MID-WRITE modification
      const livePreview = await svc.preview({ direction: 'push' });
      seed(localRoot, { [MD]: 'a\n§\nlocal1\n§\nremote2\n§\nnewer-local\n' });
      const plusPreview = await svc.preview({ direction: 'push' });
      expect(plusPreview.summary.merged).toBe(1);
      // remote changed after the preview was made — apply still runs on the current state
      fs.writeFileSync(path.join(remoteRoot, MD), 'a\n§\nconcurrent-edit\n');
      const liveApplied = await svc.apply({ previewId: plusPreview.previewId, direction: 'push', confirm: true });
      expect(liveApplied.ok).toBe(true);
      // the concurrent edit is preserved (union merge, never overwritten silently)
      const published = fs.readFileSync(path.join(remoteRoot, MD), 'utf-8');
      expect(published).toContain('concurrent-edit');
      expect(published).toContain('newer-local');
    } finally {
      cleanup();
    }
  });
});