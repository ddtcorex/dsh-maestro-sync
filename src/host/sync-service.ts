/**
 * SyncService — content-aware, preview-bound merge for DSH state.
 *
 * Safety contract (docs/specs/2026-08-31-dsh-maestro-sync-remediation-design.md):
 * - preview() is read-only: it stages remote eligible files once via argv-only
 *   rsync --files-from into a private temp dir and hashes raw Buffers. Binary
 *   session artifacts (.jsonl.zstd) are never UTF-8-decoded.
 * - apply({previewId, direction, confirm:true}) is the ONLY mutation route. It
 *   re-inventories the local and remote sides, recomputes the plan, and rejects
 *   a changed inventory as STALE_PREVIEW before any write.
 * - Pull publishes each destination through backup + fsync tmp + rename + dir
 *   fsync. Push materializes every output below a private operation dir, uploads
 *   to <root>/.maestro-sync/stage/<op>/ and commits through the fixed remote
 *   CAS helper (expectedTargetSha256); a mismatch is CONCURRENT_MODIFICATION.
 * - Legacy pull()/push() are preview-only compatibility aliases and never write.
 */
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { mergeDelimited } from './merge.js';
import { mergeSessionBuffers } from './session-plan.js';
import { snapshotFile } from './snapshot.js';
import { buildPlan, buildPreview, getPreview, getPreviewDirection, deletePreview, storePreview } from './sync-plan.js';
import { normalizeEligiblePath, validateRemoteTarget, validateHost } from './validation.js';
import type { RemoteTarget, SyncDirection, SyncPreview, SyncSummary, SyncFailure, SyncPlan, FileSnapshot, PlannedAction, SyncProgress } from './sync-types.js';
import { createProcessRunner, type ProcessRunner } from './process-runner.js';
import { createTransport, type SyncTransport } from './transport.js';

export interface PreviewRequest {
  direction: SyncDirection;
}

export interface ApplyRequest {
  previewId: string;
  direction: SyncDirection;
  confirm: true;
}

export interface ApplyResult {
  ok: boolean;
  revision: string;
  summary: SyncSummary;
  committed: string[];
  failures: SyncFailure[];
}

export interface ConnectionStatus {
  ok: boolean;
  host: string;
  latencyMs?: number;
  error?: string;
}

/** Legacy status shape — counts never imply same path means same content. */
export interface StatusResult {
  localOnly: number;
  remoteOnly: number;
  both: number;
  localOnlyFiles: string[];
  remoteOnlyFiles: string[];
  bothFiles: string[];
  connection: ConnectionStatus;
  remoteHost: string;
}

/** Cursor-paged status page for bounded RPC payloads (< 64 KiB). */
export interface StatusPage {
  total: number;
  offset: number;
  limit: number;
  files: string[];
  nextCursor: number | null;
  connection: ConnectionStatus;
  remoteHost: string;
}

export interface PullResult {
  copied: number;
  merged: number;
  added: number;
  conflicts: number;
}

export interface PushResult {
  copied: number;
  merged: number;
  added: number;
  conflicts: number;
}

export interface PreviewResult extends SyncPreview {
  connection: ConnectionStatus;
  remoteHost: string;
}

export interface SyncServiceOpts {
  localDsh?: string;
  remote?: string;
  remoteDsh?: string;
  previewDir?: string;
  fs?: any;
  runner?: ProcessRunner;
  transport?: SyncTransport;
}

function syncFailure(phase: SyncFailure['phase'], code: string, detail: string, path?: string): Error & SyncFailure {
  return Object.assign(new Error(detail), { phase, code, detail, path });
}

export class SyncService {
  localDsh: string;
  remote: string;
  remoteDsh: string;
  previewDir: string;
  fs: any;
  runner: ProcessRunner;
  transport: SyncTransport;

  constructor(opts: SyncServiceOpts = {}) {
    this.localDsh = opts.localDsh || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.remote = opts.remote || process.env.REMOTE_HOST || process.env.REMOTE || 'kai@ssh.ddtcorex.com';
    this.remoteDsh = opts.remoteDsh || process.env.REMOTE_DSH_PATH || '~/.dsh';
    // Sidecar preview store shared by every CLI process (preview -> separate apply run).
    this.previewDir = opts.previewDir ?? path.join(this.localDsh, 'dsh-maestro-sync', 'previews');
    this.fs = opts.fs || nodeFs;
    this.runner = opts.runner ?? createProcessRunner();
    this.transport = opts.transport ?? createTransport(this.runner);
  }

  /**
   * Resolve + validate the remote target. A `~/.dsh` placeholder is resolved by
   * the transport preflight (remote $HOME bytes) — never by local shell ~ expansion.
   */
  async resolveTarget(): Promise<RemoteTarget> {
    let dshRoot = this.remoteDsh;
    if (!dshRoot || dshRoot === '~' || dshRoot.startsWith('~/') || dshRoot.startsWith('~')) {
      const home = await this.transport.remoteHome({ host: this.remote });
      const suffix = dshRoot && dshRoot.startsWith('~/') ? dshRoot.slice(2) : '.dsh';
      dshRoot = path.posix.join(home, suffix);
    }
    return validateRemoteTarget({ host: this.remote, dshRoot });
  }

  private async requireTarget(): Promise<RemoteTarget> {
    try {
      return await this.resolveTarget();
    } catch (e: any) {
      throw syncFailure('validate', 'INVALID_REMOTE_TARGET', `invalid remote target: ${e?.message ?? String(e)}`);
    }
  }

  async checkConnection(): Promise<ConnectionStatus> {
    // Validate the host before any spawn so an unsafe host can never reach ssh.
    try {
      validateHost(this.remote);
    } catch (e: any) {
      return { ok: false, host: this.remote, error: e?.message ?? 'invalid host' };
    }
    const start = Date.now();
    try {
      const res = await this.runner.run('ssh', ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', this.remote, 'echo ok'], { timeoutMs: 5000 });
      if (res.exitCode === 0) return { ok: true, host: this.remote, latencyMs: Date.now() - start };
      const detail = res.stderr.toString('utf-8').trim().slice(0, 400) || `exit ${res.exitCode}`;
      return { ok: false, host: this.remote, error: detail };
    } catch (e: any) {
      return { ok: false, host: this.remote, error: String(e?.message ?? e).slice(0, 400) };
    }
  }

  private async requireConnection(): Promise<ConnectionStatus> {
    const connection = await this.checkConnection();
    if (!connection.ok) {
      throw syncFailure('validate', 'OFFLINE', `cannot reach ${this.remote}: ${connection.error ?? 'SSH connection failed'}`);
    }
    return connection;
  }

  /**
   * Local eligible files (memories/*.md, memories/SUGGESTIONS.jsonl,
   * sessions/<cwd-hash>/<id>/session.jsonl.zstd) as relative paths, sorted.
   * Only content that matches the eligible contract is ever read or hashed.
   */
  listLocalFiles(): string[] {
    const root = this.localDsh;
    const result: string[] = [];
    const fsMod = this.fs;
    const walk = (dir: string, base: string) => {
      let entries: any[] = [];
      try {
        if (typeof fsMod.readdirSync !== 'function') return;
        const raw = fsMod.readdirSync(dir, { withFileTypes: true } as any);
        if (!raw || raw.length === 0) return;
        if (typeof raw[0] === 'string') {
          for (const name of raw as unknown as string[]) {
            const full = path.join(dir, name);
            let st: any = null;
            try {
              st = fsMod.statSync ? fsMod.statSync(full) : null;
            } catch {
              continue;
            }
            if (st && typeof st.isDirectory === 'function' && st.isDirectory()) walk(full, path.join(base, name));
            else result.push(path.join(base, name));
          }
          return;
        }
        for (const ent of raw as any[]) {
          const name = ent.name ?? String(ent);
          const full = path.join(dir, name);
          const isDir = typeof ent.isDirectory === 'function' ? ent.isDirectory() : false;
          if (isDir) walk(full, path.join(base, name));
          else result.push(path.join(base, name));
        }
      } catch {
        // best-effort walk
      }
    };
    try {
      if (fsMod.existsSync && !fsMod.existsSync(root)) return [];
    } catch {
      return [];
    }
    walk(root, '');
    return [...new Set(
      result
        .map((p) => p.split(path.sep).join('/'))
        .filter((p) => {
          try {
            normalizeEligiblePath(p);
            return true;
          } catch {
            return false;
          }
        }),
    )].sort();
  }

  /** Parse transport.list output into eligible relative paths (validated). */
  private remoteRelativePaths(target: RemoteTarget, raw: Buffer): string[] {
    const out = new Set<string>();
    for (const line of raw.toString('utf-8').split('\n')) {
      const p = line.trim();
      if (!p) continue;
      let rel: string | null = null;
      const prefix = target.dshRoot + '/';
      if (p.startsWith(prefix)) rel = p.slice(prefix.length);
      else if (p.startsWith(target.dshRoot)) rel = p.slice(target.dshRoot.length + 1);
      const idx = p.lastIndexOf('/.dsh/');
      if (rel === null && idx !== -1) rel = p.slice(idx + 6);
      if (rel === null && p.startsWith('/')) rel = p.slice(1);
      if (rel === null || !rel) continue;
      try {
        normalizeEligiblePath(rel);
        out.add(rel);
      } catch {
        // skip ineligible
      }
    }
    return [...out].sort();
  }

  private async readLocalBuffer(rel: string): Promise<Buffer> {
    const full = path.join(this.localDsh, rel);
    const fsMod = this.fs;
    if (typeof fsMod.readFileSync === 'function') {
      const data = fsMod.readFileSync(full);
      return Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), 'utf-8');
    }
    throw syncFailure('snapshot', 'LOCAL_READ_FAILED', `cannot read local file ${rel}`);
  }

  /**
   * Hash local files and stage the remote eligible files once (argv-only rsync
   * --files-from, raw Buffers preserved). Session artifacts stay binary-exact.
   * When `sessionsCountOnly` is set, session files are NOT staged: their remote
   * sha256+size are fetched over one ssh (`sha256sum`, streaming per file) so
   * preview can count added/updated/deleted without transferring content.
   */
  private async snapshotBoth(opts: { sessionsCountOnly?: boolean; onProgress?: (p: SyncProgress) => void } = {}): Promise<{
    target: RemoteTarget;
    localSnapshots: FileSnapshot[];
    remoteSnapshots: FileSnapshot[];
    localContents: Map<string, Buffer>;
    remoteContents: Map<string, Buffer>;
    cleanup: () => void;
  }> {
    const progress = (phase: SyncProgress['phase'], current: number, total: number, file?: string) => opts.onProgress?.({ phase, current, total, file });
    const isSession = (p: string) => p.endsWith('.jsonl.zstd');
    const target = await this.requireTarget();
    const localPaths = this.listLocalFiles();
    const rawRemote = await this.transport.list(target);
    const remotePaths = this.remoteRelativePaths(target, rawRemote);

    const localContents = new Map<string, Buffer>();
    const localSnapshots: FileSnapshot[] = [];
    for (const p of localPaths) {
      const buf = await this.readLocalBuffer(p);
      localContents.set(p, buf);
      localSnapshots.push(snapshotFile(p, buf));
    }

    const remoteContents = new Map<string, Buffer>();
    const remoteSnapshots: FileSnapshot[] = [];
    let stagingDir: string | null = null;
    let cleanup: () => void = () => {};
    if (remotePaths.length > 0) {
      // Stage only the change candidates: checksum-compare (rsync -rcn) first,
      // so a real DSH home with hundreds of unchanged session files is never
      // transferred wholesale.
      let changed: string[] = [];
      try {
        const compareOut = await this.transport.compare(target, this.localDsh, remotePaths);
        const changedSet = new Set(compareOut.toString('utf-8').split('\n').map((s) => s.trim()).filter(Boolean));
        changed = remotePaths.filter((p) => changedSet.has(p));
      } catch (e: any) {
        throw syncFailure('snapshot', 'COMPARE_FAILED', `remote compare failed: ${e?.message ?? String(e)}`);
      }
      if (changed.length > 0) {
        const isSessionLocal = isSession;
        const sessionChanged = opts.sessionsCountOnly ? changed.filter(isSessionLocal) : [];
        const stageChanged = opts.sessionsCountOnly ? changed.filter((p) => !isSessionLocal(p)) : changed;

        // Count-only sessions: fetch remote sha256+size over one streaming ssh
        // (as fast as a checksum pass, no byte transfer) and emit a progress tick
        // per file. Never read into remoteContents — preview only counts them.
        if (sessionChanged.length > 0) {
          let hashed = 0;
          progress('hashing', 0, sessionChanged.length);
          const hashes = await this.transport.hashes(target, sessionChanged, (h) => {
            hashed++;
            progress('hashing', hashed, sessionChanged.length, h.path);
          });
          for (const h of hashes) {
            remoteSnapshots.push({ path: h.path, sha256: h.sha256, size: h.size, kind: 'session' });
          }
        }

        if (stageChanged.length > 0) {
          stagingDir = path.join(os.tmpdir(), `maestro-sync-stage-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
          const fsMod = this.fs;
          try {
            if (typeof fsMod.mkdirSync === 'function') fsMod.mkdirSync(stagingDir, { recursive: true });
            else nodeFs.mkdirSync(stagingDir, { recursive: true });
          } catch (e: any) {
            throw syncFailure('snapshot', 'STAGE_CREATE_FAILED', `cannot create staging dir: ${e?.message}`);
          }
          cleanup = () => {
            try {
              if (typeof fsMod.rmSync === 'function') fsMod.rmSync(stagingDir!, { recursive: true, force: true });
              else nodeFs.rmSync(stagingDir!, { recursive: true, force: true });
            } catch {}
          };
          progress('staging', 0, stageChanged.length);
          try {
            await this.transport.stage(target, stageChanged, stagingDir);
          } catch (e: any) {
            throw syncFailure('snapshot', 'STAGE_FAILED', `remote staging failed: ${e?.message ?? String(e)}`);
          }
          for (const p of stageChanged) {
            const stagedPath = path.join(stagingDir, p);
            const fsMod2 = this.fs;
            let data: Buffer;
            try {
              if (typeof fsMod2.readFileSync === 'function') {
                const d = fsMod2.readFileSync(stagedPath);
                data = Buffer.isBuffer(d) ? Buffer.from(d) : Buffer.from(String(d), 'utf-8');
              } else {
                data = nodeFs.readFileSync(stagedPath);
              }
            } catch (e: any) {
              throw syncFailure('snapshot', 'STAGE_READ_FAILED', `cannot read staged file ${p}: ${e?.message}`, p);
            }
            remoteContents.set(p, data);
            remoteSnapshots.push(snapshotFile(p, data));
          }
        }
      }
      // Files the checksum compare proved byte-identical are represented by the
      // local buffer (same bytes) — never transferred, but still content-aware
      // for the pull/push plan (a push must see them as identical, not absent).
      for (const p of remotePaths) {
        if (remoteContents.has(p)) continue;
        const localBuf = localContents.get(p);
        if (!localBuf) continue;
        if (opts.sessionsCountOnly && isSession(p)) {
          // identical sessions keep their snapshot so the count-only preview
          // revision matches the apply re-inventory (sha == local bytes);
          // changed sessions were already snapshotted by hashes — never let a
          // local fill overwrite them; never load content (counted, not merged).
          if (!remoteSnapshots.some((s) => s.path === p)) {
            remoteSnapshots.push(snapshotFile(p, localBuf));
          }
          continue;
        }
        remoteContents.set(p, localBuf);
        remoteSnapshots.push(snapshotFile(p, localBuf));
      }
    }
    return { target, localSnapshots, remoteSnapshots, localContents, remoteContents, cleanup };
  }

  /**
   * Read-only preview: exact plan with copy/merge/skip/conflict and real added
   * counts — except sessions under `sessionsCountOnly`, which are counted by
   * path+checksum (added/updated/deleted/identical) without staging content.
   * `onProgress` receives per-phase ticks (hashing emits one per session file).
   * No preview path may copy, backup, restore or publish.
   */
  async preview(opts: { direction: SyncDirection; sessionsCountOnly?: boolean; onProgress?: (p: SyncProgress) => void }): Promise<PreviewResult> {
    const direction: SyncDirection = opts.direction === 'push' ? 'push' : 'pull';
    const connection = await this.requireConnection();
    const { localSnapshots, remoteSnapshots, localContents, remoteContents, cleanup } = await this.snapshotBoth({
      sessionsCountOnly: opts.sessionsCountOnly,
      onProgress: opts.onProgress,
    });
    try {
      opts.onProgress?.({ phase: 'planning', current: 0, total: 1 });
      const preview = await buildPreview(localSnapshots, remoteSnapshots, direction, localContents, remoteContents, { countOnlySessions: opts.sessionsCountOnly });
      // persist so a separate CLI apply process can consume this preview
      storePreview(preview, direction, this.previewDir);
      opts.onProgress?.({ phase: 'planning', current: 1, total: 1 });
      return { ...preview, connection, remoteHost: this.remote };
    } finally {
      cleanup();
    }
  }

  private assertApplyRequest(req: ApplyRequest): void {
    if (!req || typeof req.previewId !== 'string' || req.previewId.length === 0) {
      throw syncFailure('validate', 'INVALID_PREVIEW_ID', 'apply requires previewId');
    }
    if ((req as any).confirm !== true) {
      throw syncFailure('validate', 'CONFIRM_REQUIRED', 'apply requires confirm:true');
    }
    if (req.direction !== 'pull' && req.direction !== 'push') {
      throw syncFailure('validate', 'INVALID_DIRECTION', 'apply requires direction pull|push');
    }
  }

  /** Merge dispatcher — bytes stay bytes for zstd; md/jsonl use deterministic unions. */
  private mergeBuffer(
    act: PlannedAction,
    localContents: Map<string, Buffer>,
    remoteContents: Map<string, Buffer>,
    direction: SyncDirection,
  ): Buffer {
    const localBuf = localContents.get(act.path);
    const remoteBuf = remoteContents.get(act.path);
    if (!localBuf || !remoteBuf) {
      throw syncFailure('plan', 'MISSING_CONTENT', `missing content for merge ${act.path}`, act.path);
    }
    if (act.path.endsWith('.zstd')) {
      const { merged } = direction === 'pull' ? mergeSessionBuffers(localBuf, remoteBuf) : mergeSessionBuffers(remoteBuf, localBuf);
      return merged;
    }
    if (act.path.endsWith('.jsonl')) {
      const base = direction === 'pull' ? localBuf : remoteBuf;
      const incoming = direction === 'pull' ? remoteBuf : localBuf;
      const baseLines = base.toString('utf-8').split('\n').filter((l) => l.length > 0);
      const incomingLines = incoming.toString('utf-8').split('\n').filter((l) => l.length > 0);
      const seen = new Set(baseLines);
      const mergedArr = [...baseLines];
      for (const line of incomingLines) if (!seen.has(line)) { seen.add(line); mergedArr.push(line); }
      return Buffer.from(mergedArr.join('\n') + (mergedArr.length ? '\n' : ''), 'utf-8');
    }
    if (act.path.endsWith('.md')) {
      const localStr = localBuf.toString('utf-8');
      const remoteStr = remoteBuf.toString('utf-8');
      const { mergedText } = direction === 'pull' ? mergeDelimited(localStr, remoteStr) : mergeDelimited(remoteStr, localStr);
      return Buffer.from(mergedText, 'utf-8');
    }
    throw syncFailure('plan', 'UNKNOWN_KIND', `unknown kind for ${act.path}`, act.path);
  }

  private async atomicWriteWithBackup(fullPath: string, content: Buffer): Promise<void> {
    const fsMod = this.fs;
    const dir = path.dirname(fullPath);
    try {
      if (fsMod.mkdirSync) fsMod.mkdirSync(dir, { recursive: true });
      else if (fsMod.promises?.mkdir) await fsMod.promises.mkdir(dir, { recursive: true });
    } catch {
      // ignore mkdir errors
    }
    // backup existing bytes — per-file atomic publication requires a recoverable copy
    try {
      const exists = fsMod.existsSync ? fsMod.existsSync(fullPath) : false;
      if (exists) {
        const bak = `${fullPath}.bak.${Date.now()}.${randomBytes(4).toString('hex')}`;
        if (typeof fsMod.copyFileSync === 'function') fsMod.copyFileSync(fullPath, bak);
        else if (typeof fsMod.writeFileSync === 'function' && typeof fsMod.readFileSync === 'function') fsMod.writeFileSync(bak, fsMod.readFileSync(fullPath));
      }
    } catch {
      // backup best-effort (failure to back up is not a publish failure, but we must not lose the write)
    }
    const tmp = `${fullPath}.tmp.${randomBytes(4).toString('hex')}`;
    try {
      if (typeof fsMod.writeFileSync === 'function') fsMod.writeFileSync(tmp, content);
      else nodeFs.writeFileSync(tmp, content);
      // fsync the temp file
      try {
        if (typeof fsMod.openSync === 'function' && typeof fsMod.fsyncSync === 'function' && typeof fsMod.closeSync === 'function') {
          const fd = fsMod.openSync(tmp, 'r');
          try {
            fsMod.fsyncSync(fd);
          } finally {
            fsMod.closeSync(fd);
          }
        }
      } catch {}
      if (typeof fsMod.renameSync === 'function') fsMod.renameSync(tmp, fullPath);
      else {
        if (typeof fsMod.writeFileSync === 'function') fsMod.writeFileSync(fullPath, content);
        else nodeFs.writeFileSync(fullPath, content);
        try {
          if (fsMod.existsSync && fsMod.existsSync(tmp) && fsMod.unlinkSync) fsMod.unlinkSync(tmp);
        } catch {}
      }
      // fsync the directory
      try {
        if (typeof fsMod.openSync === 'function' && typeof fsMod.fsyncSync === 'function' && typeof fsMod.closeSync === 'function') {
          const dfd = fsMod.openSync(dir, 'r');
          try {
            fsMod.fsyncSync(dfd);
          } finally {
            fsMod.closeSync(dfd);
          }
        }
      } catch {}
    } catch (e: any) {
      throw syncFailure('publish', 'ATOMIC_WRITE_FAILED', `atomic publish failed for ${fullPath}: ${e?.message}`);
    }
  }

  /**
   * Apply a previously generated preview (the only mutation route).
   * Re-inventories both sides and applies the FRESHEST plan — DSH homes change
   * continuously (session logs are appended every turn), so a byte-for-byte
   * inventory comparison would reject nearly every live apply (STALE_PREVIEW).
   * Safety stays fail-closed without it: each file publish carries the
   * expected target sha (CAS) and a preview is single-use, so a concurrent
   * modification during the write is still rejected and nothing is overwritten
   * silently. Pull publishes atomically per local file; push materializes,
   * uploads and commits through the remote CAS helper.
   */
  async apply(req: ApplyRequest): Promise<ApplyResult> {
    this.assertApplyRequest(req);
    const preview = getPreview(req.previewId, this.previewDir);
    if (!preview) throw syncFailure('validate', 'STALE_PREVIEW', 'preview not found or expired (60s)');
    const storedDir = getPreviewDirection(req.previewId);
    if (storedDir && storedDir !== req.direction) {
      throw syncFailure('validate', 'DIRECTION_MISMATCH', `preview is ${storedDir} but apply direction is ${req.direction}`);
    }
    await this.requireConnection();

    const { target, localSnapshots, remoteSnapshots, localContents, remoteContents, cleanup } = await this.snapshotBoth();
    try {
      const fresh = await buildPlan(localSnapshots, remoteSnapshots, req.direction, localContents, remoteContents);

      const committed: string[] = [];
      const failures: SyncFailure[] = [];
      const targetSide: 'local' | 'remote' = req.direction === 'pull' ? 'local' : 'remote';
      const toPublish = fresh.actions.filter((a) => a.target === targetSide && (a.action === 'copy' || a.action === 'merge'));

      if (req.direction === 'pull') {
        for (const act of toPublish) {
          try {
            normalizeEligiblePath(act.path);
            let buf: Buffer;
            if (act.action === 'copy') {
              const remoteBuf = remoteContents.get(act.path);
              if (!remoteBuf) throw syncFailure('publish', 'MISSING_REMOTE', `missing remote content for ${act.path}`, act.path);
              buf = remoteBuf;
            } else {
              buf = this.mergeBuffer(act, localContents, remoteContents, 'pull');
            }
            await this.atomicWriteWithBackup(path.join(this.localDsh, act.path), buf);
            committed.push(act.path);
          } catch (e: any) {
            failures.push(syncFailure('publish', e?.code ?? 'PUBLISH_FAILED', String(e?.message ?? e), act.path) as SyncFailure);
          }
        }
      } else {
        if (toPublish.length > 0) {
          const operationId = randomBytes(8).toString('hex');
          const stagingDir = path.join(os.tmpdir(), `maestro-push-stage-${process.pid}-${operationId}`);
          const fsMod = this.fs;
          try {
            if (typeof fsMod.mkdirSync === 'function') fsMod.mkdirSync(stagingDir, { recursive: true });
            else nodeFs.mkdirSync(stagingDir, { recursive: true });
          } catch (e: any) {
            throw syncFailure('publish', 'STAGE_CREATE_FAILED', `cannot create push staging dir: ${e?.message}`);
          }
          const cleanupStaging = () => {
            try {
              if (typeof fsMod.rmSync === 'function') fsMod.rmSync(stagingDir, { recursive: true, force: true });
              else nodeFs.rmSync(stagingDir, { recursive: true, force: true });
            } catch {}
          };
          try {
            // Materialize every output first; a failure here publishes nothing.
            const paths: string[] = [];
            for (const act of toPublish) {
              normalizeEligiblePath(act.path);
              let buf: Buffer;
              if (act.action === 'copy') {
                const localBuf = localContents.get(act.path);
                if (!localBuf) throw syncFailure('publish', 'MISSING_LOCAL', `missing local content for ${act.path}`, act.path);
                buf = localBuf;
              } else {
                buf = this.mergeBuffer(act, localContents, remoteContents, 'push');
              }
              const dest = path.join(stagingDir, act.path);
              const fsMod2 = this.fs;
              try {
                if (typeof fsMod2.mkdirSync === 'function') fsMod2.mkdirSync(path.dirname(dest), { recursive: true });
                else nodeFs.mkdirSync(path.dirname(dest), { recursive: true });
              } catch {}
              if (typeof fsMod2.writeFileSync === 'function') fsMod2.writeFileSync(dest, buf);
              else nodeFs.writeFileSync(dest, buf);
              paths.push(act.path);
            }

            try {
              await this.transport.ensureAgent(target);
            } catch (e: any) {
              throw syncFailure('publish', 'AGENT_INSTALL_FAILED', `remote agent install failed: ${e?.message ?? String(e)}`);
            }
            try {
              await this.transport.upload(target, stagingDir, paths, operationId);
            } catch (e: any) {
              for (const p of paths) failures.push(syncFailure('publish', 'UPLOAD_FAILED', `upload failed: ${e?.message ?? String(e)}`, p) as SyncFailure);
            }
            if (failures.length === 0) {
              const manifest = Buffer.from(toPublish.map((a) => JSON.stringify({ path: a.path, expected: a.expectedTargetSha256 ?? 'absent' }) + '\n').join(''), 'utf-8');
              try {
                await this.transport.commit(target, operationId, manifest);
                committed.push(...paths);
              } catch (e: any) {
                const code = e?.code && e.code !== 'TRANSPORT_ERROR' ? e.code : 'COMMIT_FAILED';
                for (const p of paths) failures.push(syncFailure('publish', code, `remote commit failed: ${e?.message ?? String(e)}`, p) as SyncFailure);
              }
            }
          } finally {
            cleanupStaging();
          }
        }
      }

      // A preview is invalidated by any apply attempt that passed validation.
      deletePreview(req.previewId, this.previewDir);
      return { ok: failures.length === 0, revision: fresh.revision, summary: fresh.summary, committed, failures };
    } finally {
      cleanup();
    }
  }

  // ---- legacy preview-only compatibility (never writes) ----

  /** Deprecated: preview-only alias. `dryRun` is ignored; nothing is ever applied here. */
  async pull(_opts: { dryRun?: boolean } = {}): Promise<PullResult> {
    const preview = await this.preview({ direction: 'pull' });
    return { copied: preview.summary.copied, merged: preview.summary.merged, added: preview.summary.added, conflicts: preview.summary.conflicts };
  }

  /** Deprecated: preview-only alias. `dryRun` is ignored; nothing is ever applied here. */
  async push(_opts: { dryRun?: boolean } = {}): Promise<PushResult> {
    const preview = await this.preview({ direction: 'push' });
    return { copied: preview.summary.copied, merged: preview.summary.merged, added: preview.summary.added, conflicts: preview.summary.conflicts };
  }

  // ---- status ----

  async status(): Promise<StatusResult> {
    const connection = await this.checkConnection();
    const localFiles = this.listLocalFiles();
    if (!connection.ok) {
      return { localOnly: localFiles.length, remoteOnly: 0, both: 0, localOnlyFiles: localFiles, remoteOnlyFiles: [], bothFiles: [], connection, remoteHost: this.remote };
    }
    let remoteFiles: string[] = [];
    try {
      const target = await this.requireTarget();
      remoteFiles = this.remoteRelativePaths(target, await this.transport.list(target));
    } catch {
      remoteFiles = [];
    }
    const localSet = new Set(localFiles);
    const remoteSet = new Set(remoteFiles);
    const bothFiles = localFiles.filter((f) => remoteSet.has(f));
    const localOnlyFiles = localFiles.filter((f) => !remoteSet.has(f));
    const remoteOnlyFiles = remoteFiles.filter((f) => !localSet.has(f));
    return {
      localOnly: localOnlyFiles.length,
      remoteOnly: remoteOnlyFiles.length,
      both: bothFiles.length,
      localOnlyFiles,
      remoteOnlyFiles,
      bothFiles,
      connection,
      remoteHost: this.remote,
    };
  }

  /**
   * Cursor-paged status page — bounded output.
   * Buckets are ACTION-based (like preview): `remoteOnly` lists every file a
   * pull would bring in (remote-only paths + both-side content differences),
   * `localOnly` lists what a push would send (local-only paths + content
   * differences). A live DSH home keeps path lists mostly equal between the
   * two machines while session content diverges, so path-only buckets would
   * stay 0/0 and hide the real changes.
   */
  async statusPage(opts: { bucket?: string; cursor?: number; limit?: number } = {}): Promise<StatusPage> {
    const st = await this.status();
    const bucket = opts.bucket === 'remoteOnly' || opts.bucket === 'localOnly' ? opts.bucket : 'localOnly';
    const offset = Math.max(0, Math.trunc(opts.cursor ?? 0));
    const limit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 100)));

    // Which remote files differ in content (rsync -rcn: remote-only paths plus
    // both-side checksum differences) — exactly the pull candidates. Reuses the
    // remote paths already fetched by status() so this adds one compare pass.
    let remoteChanged = new Set<string>();
    try {
      const target = await this.requireTarget();
      const remotePaths = [...st.remoteOnlyFiles, ...st.bothFiles];
      const compareOut = await this.transport.compare(target, this.localDsh, remotePaths);
      remoteChanged = new Set(compareOut.toString('utf-8').split('\n').map((s) => s.trim()).filter(Boolean));
    } catch {
      // offline/compare failure → fall back to path-only buckets (may be empty)
    }

    let all: string[];
    if (bucket === 'remoteOnly') {
      // pull brings: remote-only paths (copy) + both-side content diffs (merge)
      all = [...st.remoteOnlyFiles];
      for (const p of st.bothFiles) if (remoteChanged.has(p)) all.push(p);
    } else {
      // push sends: local-only paths (copy) + content diffs on shared paths (merge)
      all = [...st.localOnlyFiles];
      for (const p of st.bothFiles) if (remoteChanged.has(p)) all.push(p);
    }
    all = [...new Set(all)].sort();

    const files = all.slice(offset, offset + limit);
    const nextCursor = offset + files.length < all.length ? offset + files.length : null;
    return { total: all.length, offset, limit, files, nextCursor, connection: st.connection, remoteHost: st.remoteHost };
  }
}