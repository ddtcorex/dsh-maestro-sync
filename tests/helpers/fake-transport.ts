/**
 * Hermetic fake remote for service tests.
 *
 * The fake holds a `remote` Map<string, Buffer> of the remote DSH root and
 * mirrors the real SshRsyncTransport + remote-agent semantics:
 * - manifest(target)  -> validated eligible RemoteManifestEntry[] (path/sha/size)
 * - stage(target, paths, dest) -> writes raw Buffers into dest (real fs), byte-exact
 * - upload(target, source, paths, operationId) -> reads raw Buffers from source, records them in `.maestro-sync/stage/<op>/`
 * - commit(target, operationId, manifest) -> compare-and-swap: verifies every target still
 *   matches its expected SHA-256 (or is absent when expected === 'absent') before publishing;
 *   a mismatch throws CONCURRENT_MODIFICATION and writes nothing for that entry.
 * - warmCache(target) -> counts invocations (push-apply refreshes the remote fp cache)
 * - remoteHome(target) -> '/home/kai'
 *
 * `calls` records upload/commit/stage/manifest/warmCache invocations for assertions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import type { SyncTransport } from '../../src/host/transport.js';
import type { RemoteTarget } from '../../src/host/sync-types.js';
import type { RemoteManifestEntry } from '../../src/host/remote-manifest.js';
import { normalizeEligiblePath } from '../../src/host/validation.js';

export interface FakeRemoteResult {
  transport: SyncTransport;
  remote: Map<string, Buffer>;
  calls: {
    stage: { dest: string; paths: string[] }[];
    upload: { source: string; paths: string[]; operationId: string }[];
    commit: { operationId: string; manifest: Buffer }[];
    manifest: number;
    ensureAgent?: number;
    warmCache?: number;
  };
  failNextCommitOnce?: boolean;
  failUploadAfter?: number;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function createFakeRemote(initial: Map<string, Buffer> = new Map(), dshRoot = '/home/kai/.dsh'): FakeRemoteResult {
  const remote = new Map<string, Buffer>();
  for (const [p, buf] of initial) remote.set(p, Buffer.from(buf));
  const staged = new Map<string, Map<string, Buffer>>();
  const result: FakeRemoteResult = {
    remote,
    calls: { stage: [], upload: [], commit: [], manifest: 0 },
    transport: {
      remoteHome: async () => '/home/kai',
      stage: async (target: RemoteTarget, paths: readonly string[], destination: string) => {
        result.calls.stage.push({ dest: destination, paths: [...paths] });
        for (const rel of paths) {
          const buf = remote.get(rel);
          if (buf === undefined) throw Object.assign(new Error(`stage: remote file missing ${rel}`), { phase: 'stage', code: 'STAGE_FAILED' });
          const full = path.join(destination, rel);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, buf);
        }
      },
      manifest: async (): Promise<RemoteManifestEntry[]> => {
        result.calls.manifest++;
        const out: RemoteManifestEntry[] = [];
        for (const [rel, buf] of remote) {
          try {
            normalizeEligiblePath(rel);
          } catch {
            continue;
          }
          out.push({ path: rel, sha256: sha256(buf), size: buf.length, mtimeSec: 0 });
        }
        return out.sort((a, b) => a.path.localeCompare(b.path));
      },
      upload: async (target: RemoteTarget, source: string, paths: readonly string[], operationId: string) => {
        if (result.failUploadAfter !== undefined && result.calls.upload.length >= result.failUploadAfter) {
          throw Object.assign(new Error('upload failed (injected)'), { phase: 'publish', code: 'UPLOAD_FAILED' });
        }
        result.calls.upload.push({ source, paths: [...paths], operationId });
        const op = staged.get(operationId) ?? new Map<string, Buffer>();
        for (const rel of paths) {
          const full = path.join(source, rel);
          if (!fs.existsSync(full)) throw Object.assign(new Error(`upload: missing staged file ${rel}`), { phase: 'publish', code: 'UPLOAD_FAILED' });
          op.set(rel, fs.readFileSync(full));
        }
        staged.set(operationId, op);
      },
      ensureAgent: async () => {
        result.calls.ensureAgent = (result.calls.ensureAgent ?? 0) + 1;
      },
      warmCache: async () => {
        result.calls.warmCache = (result.calls.warmCache ?? 0) + 1;
      },
      commit: async (target: RemoteTarget, operationId: string, manifest: Buffer) => {
        if (result.failNextCommitOnce) {
          result.failNextCommitOnce = false;
          throw Object.assign(new Error('commit failed (injected)'), { phase: 'publish', code: 'COMMIT_FAILED' });
        }
        result.calls.commit.push({ operationId, manifest });
        const entries = manifest
          .toString('utf-8')
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as { path: string; expected?: string | null });
        const op = staged.get(operationId);
        if (!op) throw Object.assign(new Error('commit: no staged operation'), { phase: 'publish', code: 'COMMIT_FAILED' });
        for (const entry of entries) {
          const current = remote.get(entry.path);
          const expected = entry.expected ?? 'absent';
          const currentHash = current === undefined ? 'absent' : sha256(current);
          if (currentHash !== expected) {
            throw Object.assign(new Error(`CONCURRENT_MODIFICATION: ${entry.path}`), {
              phase: 'publish',
              code: 'REMOTE_COMMIT_FAILED',
              detail: `CONCURRENT_MODIFICATION for ${entry.path}`,
            });
          }
          const buf = op.get(entry.path);
          if (buf === undefined) throw Object.assign(new Error(`commit: missing staged content ${entry.path}`), { phase: 'publish', code: 'COMMIT_FAILED' });
          // backup + publish (rename semantics kept simple; the real agent is tested separately)
          if (current !== undefined) {
            const bak = `${entry.path}.bak.${Date.now()}.${randomBytes(4).toString('hex')}`;
            remote.set(bak, Buffer.from(current));
          }
          remote.set(entry.path, Buffer.from(buf));
        }
      },
    } as unknown as SyncTransport,
  };
  return result;
}

/** Real temp dir pair: localRoot (live) and a scratch root for staging assertions. */
export function makeTempRoots(prefix: string): { localRoot: string; cleanup: () => void } {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    localRoot,
    cleanup: () => {
      try {
        fs.rmSync(localRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}