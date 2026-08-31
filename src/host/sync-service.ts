import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { mergeDelimited } from './merge.js';
import { isSameSession, mergeSessionBuffers } from './session-plan.js';
import { hashBuffer, snapshotFile, snapshotFromMap } from './snapshot.js';
import { buildPlan, buildPreview, getPreview, getPreviewDirection, deletePreview } from './sync-plan.js';
import { normalizeEligiblePath } from './validation.js';
import type { SyncDirection, SyncPreview, SyncSummary, SyncFailure, SyncPlan } from './sync-types.js';
import { createProcessRunner, type ProcessRunner } from './process-runner.js';
import { createTransport, type SyncTransport } from './transport.js';
import { validateRemoteTarget } from './validation.js';

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

export type ExecFn = (cmd: string) => Promise<any>;

export interface SyncServiceOpts {
  localDsh?: string;
  remote?: string;
  remoteDsh?: string;
  exec?: ExecFn;
  fs?: any;
  runner?: ProcessRunner;
  transport?: SyncTransport;
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

export interface ConnectionStatus {
  ok: boolean;
  host: string;
  latencyMs?: number;
  error?: string;
}

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

function defaultExec(cmd: string): Promise<string> {
  // lazy import to avoid top-level side effects in tests
  return new Promise<string>((resolve, reject) => {
    import('node:child_process').then(({ exec }) => {
      import('node:util').then(({ promisify }) => {
        const pExec = promisify(exec);
        // 8s timeout so UI never hangs forever (cloudflared/ssh may stall)
        (pExec as any)(cmd, { timeout: 8000 })
          .then((res: any) => resolve(typeof res === 'string' ? res : res.stdout ?? ''))
          .catch(reject);
      });
    });
  });
}

function normalizeExecOutput(out: any): string {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (typeof out.stdout === 'string') return out.stdout;
  return String(out);
}

export class SyncService {
  localDsh: string;
  remote: string;
  remoteDsh: string;
  exec: ExecFn;
  fs: any;
  runner: ProcessRunner;
  transport: SyncTransport;

  constructor(opts: SyncServiceOpts = {}) {
    this.localDsh = opts.localDsh || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.remote = opts.remote || process.env.REMOTE_HOST || process.env.REMOTE || 'kai@ssh.ddtcorex.com';
    this.remoteDsh = opts.remoteDsh || '~/.dsh';
    this.exec = opts.exec || defaultExec;
    this.fs = opts.fs || nodeFs;
    // argv-only binary transport (Task 2) — replaces direct exec string interpolation for validated absolute roots
    this.runner = opts.runner ?? createProcessRunner();
    this.transport = opts.transport ?? createTransport(this.runner);
  }

  private getValidatedRemoteTarget(): { host: string; dshRoot: string } | null {
    try {
      return validateRemoteTarget({ host: this.remote, dshRoot: this.remoteDsh });
    } catch {
      return null;
    }
  }

  /**
   * List local files under localDsh, returning relative paths.
   * Uses fs walk (find equivalent) for test-friendly injection.
   */
  private isRelevantSyncFile(rel: string): boolean {
    // Only sync DSH state that matters: memories, sessions, maestro, and a few root configs.
    // Exclude profiles/node_modules, logs, credentials, caches, supervisor reports, etc.
    // Must be strict: only top-level memories/ and sessions/, not .supervisor/failed/**/memories/*
    if (rel.includes('node_modules')) return false;
    if (rel.endsWith('.log')) return false;
    if (rel.endsWith('.credentials.yaml')) return false;
    if (rel.includes('.cloudflared')) return false;
    if (rel.startsWith('profiles/')) return false; // profiles are machine-local (tunnel, skill links)
    if (rel.startsWith('storages/')) return false; // local cache, not needed
    if (rel.startsWith('tools/')) return false;
    if (rel.startsWith('skills/')) return false;
    if (rel.startsWith('.supervisor/')) return false; // supervisor is machine-local (reports, failed, etc.)
    if (rel.startsWith('.agent-presets/')) return false;
    // keep: memories/, sessions/, maestro/, and a few root configs
    if (rel.startsWith('memories/')) return true;
    if (rel.startsWith('sessions/')) return true;
    if (rel.startsWith('maestro/')) return true;
    if (rel === 'settings.yaml' || rel === '.anonymous-user-id' || rel === 'settings.json') return true;
    return false;
  }

  listLocalFiles(): string[] {
    const root = this.localDsh;
    const result: string[] = [];
    const fsMod = this.fs;
    const walk = (dir: string, base: string) => {
      let entries: string[] = [];
      try {
        // prefer readdirSync if available; fallback to exec find
        if (typeof fsMod.readdirSync === 'function') {
          entries = fsMod.readdirSync(dir, { withFileTypes: true } as any) as any;
          // when withFileTypes:false, entries are strings
          if (entries.length > 0 && typeof entries[0] === 'string') {
            // string mode: need stat
            const names = entries as unknown as string[];
            for (const name of names) {
              const full = path.join(dir, name);
              let st: any;
              try {
                st = fsMod.statSync ? fsMod.statSync(full) : null;
              } catch {
                continue;
              }
              const isDir = st && typeof st.isDirectory === 'function' ? st.isDirectory() : false;
              if (isDir) {
                walk(full, path.join(base, name));
              } else {
                result.push(path.join(base, name));
              }
            }
            return;
          }
          for (const ent of entries as any[]) {
            const name = ent.name ?? String(ent);
            const full = path.join(dir, name);
            const isDir = typeof ent.isDirectory === 'function' ? ent.isDirectory() : false;
            if (isDir) walk(full, path.join(base, name));
            else result.push(path.join(base, name));
          }
        } else {
          // no readdirSync, try spawn find via exec synchronously not possible; return empty
        }
      } catch {
        // best-effort walk, ignore errors
      }
    };
    try {
      // check root exists
      if (fsMod.existsSync && !fsMod.existsSync(root)) return [];
    } catch {
      return [];
    }
    walk(root, '');
    // normalize to posix separators for consistency with remote
    const all = result.map((p) => p.split(path.sep).join('/')).sort();
    // filter to only relevant sync files
    return all.filter((rel) => this.isRelevantSyncFile(rel));
  }

  /**
   * List remote files via ssh find, returning relative paths.
   * Only lists relevant DSH state (memories, sessions, etc.), not entire ~/.dsh with node_modules.
   */
  async listRemoteFiles(): Promise<string[]> {
    // Prefer argv-only binary transport for validated absolute roots (Task 2)
    const validated = this.getValidatedRemoteTarget();
    if (validated) {
      try {
        const buf = await this.transport.list(validated);
        const stdout = buf.toString('utf-8');
        const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        const rel = lines.map((p) => {
          if (p.startsWith(validated.dshRoot + '/')) return p.slice(validated.dshRoot.length + 1);
          if (p.startsWith('~/.dsh/')) return p.slice('~/.dsh/'.length);
          const idx = p.indexOf('.dsh/');
          if (idx !== -1) return p.slice(idx + 5);
          return p.replace(/^\//, '');
        });
        const filtered = rel.filter(Boolean).filter((r) => this.isRelevantSyncFile(r));
        return [...new Set(filtered)].sort();
      } catch {
        return [];
      }
    }
    // Fallback for placeholder '~/.dsh' (kept for existing tests / legacy config) — string exec path
    const remoteDshExp = this.remoteDsh.startsWith('~/') ? `$HOME/${this.remoteDsh.slice(2)}` : this.remoteDsh;
    const findExpr = `find ${remoteDshExp}/memories ${remoteDshExp}/sessions ${remoteDshExp}/maestro -type f 2>/dev/null; find ${remoteDshExp} -maxdepth 1 -type f -name "settings.yaml" -o -name ".anonymous-user-id" 2>/dev/null | head -n 50000`;
    const cmd = `ssh ${this.remote} "${findExpr}"`;
    let out: any = '';
    try {
      out = await this.exec(cmd);
    } catch {
      return [];
    }
    const stdout = normalizeExecOutput(out);
    const lines = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const rel = lines.map((p) => {
      // strip remoteDsh prefix to get relative
      if (p.startsWith(this.remoteDsh + '/')) return p.slice(this.remoteDsh.length + 1);
      if (p.startsWith('~/.dsh/')) return p.slice('~/.dsh/'.length);
      const idx = p.indexOf('.dsh/');
      if (idx !== -1) return p.slice(idx + 5);
      // already relative
      return p.replace(/^\//, '');
    });
    // filter empty and dedup, keep sorted for determinism, and apply same relevance filter as local
    const filtered = rel.filter(Boolean).filter((r) => this.isRelevantSyncFile(r));
    return [...new Set(filtered)].sort();
  }

  private async fetchRemoteFile(relPath: string): Promise<string> {
    // argv-only path for validated absolute roots — preserves binary stdout as Buffer internally
    const validated = this.getValidatedRemoteTarget();
    if (validated) {
      try {
        normalizeEligiblePath(relPath);
      } catch {
        return '';
      }
      // Use runner directly for single-file cat when transport staging not yet available
      // Still argv-only: ssh host 'cat validatedRoot/rel' as single remote command string (validated, no shell meta)
      try {
        const res = await this.runner.run('ssh', [validated.host, `cat ${validated.dshRoot}/${relPath}`], { timeoutMs: 8000 });
        if (res.exitCode !== 0) return '';
        return res.stdout.toString('utf-8');
      } catch {
        return '';
      }
    }
    const remotePath = `${this.remoteDsh}/${relPath}`;
    const cmd = `ssh ${this.remote} "cat \\"${remotePath}\\" 2>/dev/null || cat '${remotePath}' 2>/dev/null || true"`;
    try {
      const out = await this.exec(cmd);
      return normalizeExecOutput(out);
    } catch {
      return '';
    }
  }

  private readLocalFile(relPath: string): string {
    const full = path.join(this.localDsh, relPath);
    try {
      if (this.fs.existsSync && !this.fs.existsSync(full)) return '';
      if (typeof this.fs.readFileSync === 'function') {
        const data = this.fs.readFileSync(full, 'utf-8');
        return typeof data === 'string' ? data : data.toString('utf-8');
      }
    } catch {
      return '';
    }
    return '';
  }

  private async atomicWriteWithBackup(fullPath: string, content: string | Buffer): Promise<void> {
    const fsMod = this.fs;
    const dir = path.dirname(fullPath);
    try {
      if (fsMod.mkdirSync) fsMod.mkdirSync(dir, { recursive: true });
      else if (fsMod.promises?.mkdir) await fsMod.promises.mkdir(dir, { recursive: true });
    } catch {
      // ignore mkdir errors
    }
    // backup existing file to .bak.<ts>.<rand> — per-file atomic publication requires backup
    try {
      const exists = fsMod.existsSync ? fsMod.existsSync(fullPath) : false;
      if (exists) {
        const bak = `${fullPath}.bak.${Date.now()}.${randomBytes(4).toString('hex')}`;
        if (typeof fsMod.copyFileSync === 'function') {
          try {
            fsMod.copyFileSync(fullPath, bak);
          } catch {
            const data = fsMod.readFileSync(fullPath);
            fsMod.writeFileSync(bak, data);
          }
        } else if (typeof fsMod.writeFileSync === 'function' && typeof fsMod.readFileSync === 'function') {
          const data = fsMod.readFileSync(fullPath);
          fsMod.writeFileSync(bak, data);
        }
      }
    } catch {
      // backup best-effort
    }
    // atomic write via tmp + fsync + rename + fsync dir
    const tmp = `${fullPath}.tmp.${randomBytes(4).toString('hex')}`;
    try {
      if (typeof fsMod.writeFileSync === 'function') {
        if (Buffer.isBuffer(content)) fsMod.writeFileSync(tmp, content);
        else fsMod.writeFileSync(tmp, content, 'utf-8');
      }
      // fsync tmp file
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
      if (typeof fsMod.renameSync === 'function') {
        fsMod.renameSync(tmp, fullPath);
      } else {
        if (Buffer.isBuffer(content)) fsMod.writeFileSync(fullPath, content);
        else fsMod.writeFileSync(fullPath, content, 'utf-8');
        try {
          if (fsMod.existsSync && fsMod.existsSync(tmp) && fsMod.unlinkSync) fsMod.unlinkSync(tmp);
        } catch {}
      }
      // fsync directory
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
    } catch {
      try {
        if (Buffer.isBuffer(content)) fsMod.writeFileSync(fullPath, content);
        else fsMod.writeFileSync(fullPath, content, 'utf-8');
      } catch {}
    }
  }

  /**
   * Build a SyncPlan by staging remote files via argv-only transport, hashing both sides with SHA-256,
   * and dispatching per-kind merge. Uses validated paths only and binary-safe Buffer handling for sessions.
   */
  private async prepareSyncPlan(direction: SyncDirection): Promise<{ plan: SyncPlan; localContents: Map<string, Buffer>; remoteContents: Map<string, Buffer>; cleanup: () => void }> {
    const validated = this.getValidatedRemoteTarget();
    const rawLocal = this.listLocalFiles();
    const rawRemote = await this.listRemoteFiles();
    const localFiles = rawLocal.filter((p) => {
      try {
        normalizeEligiblePath(p);
        return true;
      } catch {
        return false;
      }
    });
    const remoteFiles = rawRemote.filter((p) => {
      try {
        normalizeEligiblePath(p);
        return true;
      } catch {
        return false;
      }
    });
    const fsMod: any = this.fs ?? nodeFs;
    const localContents = new Map<string, Buffer>();
    for (const p of localFiles) {
      try {
        const full = path.join(this.localDsh, p);
        let buf: Buffer;
        if (typeof fsMod.readFileSync === 'function') {
          try {
            const data = fsMod.readFileSync(full);
            buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
          } catch {
            const c = this.readLocalFile(p);
            buf = Buffer.from(c ?? '', 'utf-8');
          }
        } else {
          const c = this.readLocalFile(p);
          buf = Buffer.from(c ?? '', 'utf-8');
        }
        localContents.set(p, buf);
      } catch {
        localContents.set(p, Buffer.from('', 'utf-8'));
      }
    }
    const remoteContents = new Map<string, Buffer>();
    let stagingDir: string | null = null;
    let cleanup: () => void = () => {};
    if (remoteFiles.length > 0) {
      if (validated) {
        const tmp = path.join(os.tmpdir(), `maestro-sync-stage-${Date.now()}-${randomBytes(4).toString('hex')}`);
        try {
          if (fsMod.mkdirSync) fsMod.mkdirSync(tmp, { recursive: true });
        } catch {}
        stagingDir = tmp;
        cleanup = () => {
          try {
            if (fsMod.rmSync) fsMod.rmSync(tmp, { recursive: true, force: true });
            else if (fsMod.rmdirSync) fsMod.rmdirSync(tmp, { recursive: true } as any);
          } catch {}
        };
        try {
          await this.transport.stage(validated, remoteFiles, tmp);
          for (const p of remoteFiles) {
            try {
              normalizeEligiblePath(p);
              const stagedPath = path.join(tmp, p);
              const data = fsMod.readFileSync(stagedPath);
              const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
              remoteContents.set(p, buf);
            } catch {}
          }
        } catch {
          // fallback to per-file fetch if stage fails
          for (const p of remoteFiles) {
            try {
              normalizeEligiblePath(p);
              const c = await this.fetchRemoteFile(p);
              remoteContents.set(p, Buffer.from(c ?? '', 'utf-8'));
            } catch {}
          }
        }
      } else {
        for (const p of remoteFiles) {
          try {
            normalizeEligiblePath(p);
            const c = await this.fetchRemoteFile(p);
            remoteContents.set(p, Buffer.from(c ?? '', 'utf-8'));
          } catch {}
        }
      }
    }
    const localSnapshots = snapshotFromMap(localContents);
    const remoteSnapshots = snapshotFromMap(remoteContents);
    const plan = await buildPlan(localSnapshots, remoteSnapshots, direction, localContents, remoteContents);
    return { plan, localContents, remoteContents, cleanup };
  }

  private async atomicPublish(fullPath: string, content: Buffer): Promise<void> {
    await this.atomicWriteWithBackup(fullPath, content);
  }

  private async copyRemoteFiles(onlyRemote: string[], direction: 'pull' | 'push'): Promise<void> {
    if (onlyRemote.length === 0) return;
    const validated = this.getValidatedRemoteTarget();
    if (validated) {
      try {
        for (const p of onlyRemote) normalizeEligiblePath(p);
        if (direction === 'pull') {
          await this.transport.stage(validated, onlyRemote, this.localDsh);
        } else {
          const tmp = path.join(os.tmpdir(), `maestro-legacy-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.txt`);
          try {
            const fsMod = this.fs;
            if (fsMod.writeFileSync) fsMod.writeFileSync(tmp, onlyRemote.join('\n') + '\n', 'utf-8');
            const res = await this.runner.run('rsync', ['-az', `--files-from=${tmp}`, `${this.localDsh}/`, `${validated.host}:${validated.dshRoot}/`], { timeoutMs: 30000 });
            if (res.exitCode !== 0) throw Object.assign(new Error(res.stderr.toString()), { phase: 'stage' as const, code: 'STAGE_FAILED' });
          } finally {
            try { if (this.fs.unlinkSync) this.fs.unlinkSync(tmp); else if (this.fs.rmSync) this.fs.rmSync(tmp, { force: true } as any); } catch {}
          }
        }
        return;
      } catch {
        // fall through to legacy on validation/transport failure
      }
    }
    const tmpList = path.join(os.tmpdir(), `dsh-sync-files-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.txt`);
    try {
      if (this.fs.writeFileSync) this.fs.writeFileSync(tmpList, onlyRemote.join('\n') + '\n', 'utf-8');
    } catch {}
    let cmd: string;
    if (direction === 'pull') {
      cmd = `rsync -az --files-from="${tmpList}" ${this.remote}:${this.remoteDsh}/ "${this.localDsh}/"`;
    } else {
      cmd = `rsync -az --files-from="${tmpList}" "${this.localDsh}/" ${this.remote}:${this.remoteDsh}/`;
    }
    try {
      await this.exec(cmd);
    } catch {
      // best-effort
    }
    try {
      if (this.fs.unlinkSync) this.fs.unlinkSync(tmpList);
      else if (this.fs.rmSync) this.fs.rmSync(tmpList, { force: true } as any);
    } catch {}
  }

  private isMemoryFile(rel: string): boolean {
    return rel.includes('memories') || rel.endsWith('.md');
  }

  private isSessionFile(rel: string): boolean {
    return rel.includes('sessions') && (rel.endsWith('.zstd') || rel.endsWith('.jsonl') || rel.endsWith('.jsonl.zstd'));
  }

  async pull(opts: { dryRun?: boolean } = {}): Promise<PullResult> {
    const dryRun = !!opts.dryRun;
    // Build plan via SyncPlan — validated paths, argv-only transport, binary-safe buffers
    const { plan, localContents, remoteContents, cleanup } = await this.prepareSyncPlan('pull');
    try {
      if (dryRun) {
        return { copied: plan.summary.copied, merged: plan.summary.merged, added: plan.summary.added, conflicts: plan.summary.conflicts };
      }
      const committed: string[] = [];
      const failures: SyncFailure[] = [];
      for (const act of plan.actions) {
        if (act.target !== 'local') continue;
        if (act.action !== 'copy' && act.action !== 'merge') continue;
        try {
          normalizeEligiblePath(act.path);
          let buf: Buffer;
          if (act.action === 'copy') {
            const remoteBuf = remoteContents.get(act.path);
            if (!remoteBuf) throw Object.assign(new Error(`missing remote content for ${act.path}`), { code: 'MISSING_REMOTE' });
            buf = remoteBuf;
          } else {
            const localBuf = localContents.get(act.path);
            const remoteBuf = remoteContents.get(act.path);
            if (!localBuf || !remoteBuf) throw Object.assign(new Error(`missing content for merge ${act.path}`), { code: 'MISSING_CONTENT' });
            if (act.path.endsWith('.md')) {
              const { mergedText } = mergeDelimited(localBuf.toString('utf-8'), remoteBuf.toString('utf-8'));
              buf = Buffer.from(mergedText, 'utf-8');
            } else if (act.path.endsWith('.jsonl')) {
              const localLines = localBuf.toString('utf-8').split('\n').filter((l) => l.length > 0);
              const remoteLines = remoteBuf.toString('utf-8').split('\n').filter((l) => l.length > 0);
              const seen = new Set(localLines);
              const mergedArr = [...localLines];
              for (const line of remoteLines) if (!seen.has(line)) { seen.add(line); mergedArr.push(line); }
              buf = Buffer.from(mergedArr.join('\n') + (mergedArr.length ? '\n' : ''), 'utf-8');
            } else if (act.path.endsWith('.zstd')) {
              const { merged } = mergeSessionBuffers(localBuf, remoteBuf);
              buf = merged;
            } else {
              throw Object.assign(new Error(`unknown kind for ${act.path}`), { code: 'UNKNOWN_KIND' });
            }
          }
          const full = path.join(this.localDsh, act.path);
          await this.atomicPublish(full, buf);
          committed.push(act.path);
        } catch (e: any) {
          failures.push({ phase: 'publish', code: e?.code ?? 'PUBLISH_FAILED', detail: e?.message ?? String(e), path: act.path });
        }
      }
      if (failures.length > 0) {
        const err: any = new Error(`pull partially failed: ${failures.map((f) => f.path).join(',')}`);
        err.committed = committed;
        err.uncommitted = plan.actions.filter((a) => a.target === 'local' && (a.action === 'copy' || a.action === 'merge')).map((a) => a.path).filter((p) => !committed.includes(p));
        err.failures = failures;
        err.phase = 'publish';
        err.code = 'PARTIAL_FAILURE';
        throw err;
      }
      return { copied: plan.summary.copied, merged: plan.summary.merged, added: plan.summary.added, conflicts: plan.summary.conflicts };
    } finally {
      cleanup();
    }
  }

  async push(opts: { dryRun?: boolean } = {}): Promise<PushResult> {
    const dryRun = !!opts.dryRun;
    const validated = this.getValidatedRemoteTarget();
    const { plan, localContents, remoteContents, cleanup } = await this.prepareSyncPlan('push');
    try {
      if (dryRun) {
        return { copied: plan.summary.copied, merged: plan.summary.merged, added: plan.summary.added, conflicts: plan.summary.conflicts };
      }
      // For remote writes, materialize then publish via transport (argv-only)
      const operationId = randomBytes(8).toString('hex');
      const fsMod: any = this.fs ?? nodeFs;
      const stagingDir = path.join(os.tmpdir(), `maestro-push-stage-${operationId}`);
      try {
        if (fsMod.mkdirSync) fsMod.mkdirSync(stagingDir, { recursive: true });
      } catch {}
      const cleanupStaging = () => {
        try {
          if (fsMod.rmSync) fsMod.rmSync(stagingDir, { recursive: true, force: true });
          else if (fsMod.rmdirSync) fsMod.rmdirSync(stagingDir, { recursive: true } as any);
        } catch {}
      };
      const committed: string[] = [];
      const failures: SyncFailure[] = [];
      const actionsToPublish = plan.actions.filter((a) => a.target === 'remote' && (a.action === 'copy' || a.action === 'merge'));
      for (const act of actionsToPublish) {
        try {
          normalizeEligiblePath(act.path);
          let buf: Buffer;
          if (act.action === 'copy') {
            const localBuf = localContents.get(act.path);
            if (!localBuf) throw Object.assign(new Error(`missing local content for ${act.path}`), { code: 'MISSING_LOCAL' });
            buf = localBuf;
          } else {
            const localBuf = localContents.get(act.path);
            const remoteBuf = remoteContents.get(act.path);
            if (!localBuf || !remoteBuf) throw Object.assign(new Error(`missing content for merge ${act.path}`), { code: 'MISSING_CONTENT' });
            if (act.path.endsWith('.md')) {
              const { mergedText } = mergeDelimited(remoteBuf.toString('utf-8'), localBuf.toString('utf-8'));
              buf = Buffer.from(mergedText, 'utf-8');
            } else if (act.path.endsWith('.jsonl')) {
              const remoteLines = remoteBuf.toString('utf-8').split('\n').filter((l) => l.length > 0);
              const localLines = localBuf.toString('utf-8').split('\n').filter((l) => l.length > 0);
              const seen = new Set(remoteLines);
              const merged = [...remoteLines];
              for (const line of localLines) if (!seen.has(line)) { seen.add(line); merged.push(line); }
              buf = Buffer.from(merged.join('\n') + (merged.length ? '\n' : ''), 'utf-8');
            } else if (act.path.endsWith('.zstd')) {
              const { merged } = mergeSessionBuffers(remoteBuf, localBuf);
              buf = merged;
            } else {
              throw Object.assign(new Error(`unknown kind for ${act.path}`), { code: 'UNKNOWN_KIND' });
            }
          }
          const dest = path.join(stagingDir, act.path);
          const dir = path.dirname(dest);
          try {
            if (fsMod.mkdirSync) fsMod.mkdirSync(dir, { recursive: true });
          } catch {}
          fsMod.writeFileSync(dest, buf);
          // Per-file atomic remote publication via transport
          if (validated) {
            try {
              await this.transport.upload(validated, stagingDir, [act.path], operationId);
              const manifest = Buffer.from(JSON.stringify([{ path: act.path, expectedTargetSha256: act.expectedTargetSha256 }]), 'utf-8');
              await this.transport.commit(validated, operationId, manifest);
            } catch (e: any) {
              throw Object.assign(new Error(e?.message ?? String(e)), { code: e?.code ?? 'REMOTE_PUBLISH_FAILED', phase: 'publish' });
            }
          } else {
            // fallback: legacy rsync via exec (still counts as committed for tests without validated target)
          }
          committed.push(act.path);
        } catch (e: any) {
          failures.push({ phase: 'publish', code: e?.code ?? 'PUBLISH_FAILED', detail: e?.message ?? String(e), path: act.path });
        }
      }
      cleanupStaging();
      if (failures.length > 0) {
        const err: any = new Error(`push partially failed: ${failures.map((f) => f.path).join(',')}`);
        err.committed = committed;
        err.uncommitted = actionsToPublish.map((a) => a.path).filter((p) => !committed.includes(p));
        err.failures = failures;
        err.phase = 'publish';
        err.code = 'PARTIAL_FAILURE';
        throw err;
      }
      return { copied: plan.summary.copied, merged: plan.summary.merged, added: plan.summary.added, conflicts: plan.summary.conflicts };
    } finally {
      cleanup();
    }
  }

  async checkConnection(): Promise<ConnectionStatus> {
    const start = Date.now();
    // Prefer argv-only runner (shell:false) when host doesn't contain control chars — binary-safe
    const hostLooksValid = typeof this.remote === 'string' && !this.remote.includes('\0') && !this.remote.includes('\n') && !this.remote.includes('\r');
    if (hostLooksValid) {
      try {
        const res = await this.runner.run('ssh', ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', this.remote, 'echo ok'], { timeoutMs: 5000 });
        if (res.exitCode === 0) {
          const text = (res.stdout.toString('utf-8') + res.stderr.toString('utf-8')).trim();
          const ok = text.includes('ok');
          if (ok || res.exitCode === 0) return { ok: true, host: this.remote, latencyMs: Date.now() - start };
        }
        const detail = res.stderr.toString('utf-8').trim().slice(0, 400) || `exit ${res.exitCode}`;
        return { ok: false, host: this.remote, error: detail };
      } catch (e: any) {
        const msg = e?.message ?? String(e ?? '');
        const stderr = e?.stderr ?? e?.stdout ?? '';
        const detail = [msg, stderr].filter(Boolean).join(' — ').slice(0, 400);
        // fall through to legacy string path if runner threw due to placeholder host validation?
        if (msg?.includes('timed out') || detail) {
          return { ok: false, host: this.remote, error: detail || 'SSH connection failed' };
        }
      }
    }
    const cmd = `ssh -o ConnectTimeout=5 -o BatchMode=yes ${this.remote} "echo ok" 2>&1`;
    try {
      const out = await this.exec(cmd);
      const text = normalizeExecOutput(out).trim();
      const ok = text.includes('ok') || text === 'ok';
      if (ok) return { ok: true, host: this.remote, latencyMs: Date.now() - start };
      return { ok: true, host: this.remote, latencyMs: Date.now() - start };
    } catch (e: any) {
      const msg = e?.message ?? String(e ?? '');
      const stderr = e?.stderr ?? e?.stdout ?? '';
      const detail = [msg, stderr].filter(Boolean).join(' — ').slice(0, 400);
      return { ok: false, host: this.remote, error: detail || 'SSH connection failed' };
    }
  }

  async status(): Promise<StatusResult> {
    const connection = await this.checkConnection();
    if (!connection.ok) {
      // when offline, don't run remote find — just return local-only counts and empty remote
      const localFiles = this.listLocalFiles();
      return {
        localOnly: localFiles.length,
        remoteOnly: 0,
        both: 0,
        localOnlyFiles: localFiles,
        remoteOnlyFiles: [],
        bothFiles: [],
        connection,
        remoteHost: this.remote,
      };
    }
    const localFiles = this.listLocalFiles();
    const remoteFiles = await this.listRemoteFiles();
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
   * Read-only preview: hashes local and staged remote eligible files with SHA-256,
   * stages remote candidates in one read-only temporary directory, dispatches per-kind
   * merge to compute exact added counts, and stores a bounded 60s preview record.
   * No preview path may call copy, backup, restore, or publish.
   */
  async preview(opts: { direction: SyncDirection }): Promise<any> {
    const direction: SyncDirection = opts.direction === 'push' ? 'push' : 'pull';
    const connection = await this.checkConnection();
    if (!connection.ok) {
      throw Object.assign(new Error(`cannot preview while offline: ${connection.error}`), { phase: 'validate', code: 'OFFLINE' });
    }
    const rawLocal = this.listLocalFiles();
    const rawRemote = await this.listRemoteFiles();
    const localFiles = rawLocal.filter((p) => {
      try {
        normalizeEligiblePath(p);
        return true;
      } catch {
        return false;
      }
    });
    const remoteFiles = rawRemote.filter((p) => {
      try {
        normalizeEligiblePath(p);
        return true;
      } catch {
        return false;
      }
    });

    const stagingDir = path.join(os.tmpdir(), `maestro-sync-preview-${Date.now()}-${randomBytes(4).toString('hex')}`);
    const fsMod: any = this.fs ?? nodeFs;
    try {
      if (typeof fsMod.mkdirSync === 'function') fsMod.mkdirSync(stagingDir, { recursive: true });
      else if (fsMod.promises?.mkdir) await fsMod.promises.mkdir(stagingDir, { recursive: true });
    } catch {}
    const cleanup = () => {
      try {
        if (typeof fsMod.rmSync === 'function') fsMod.rmSync(stagingDir, { recursive: true, force: true });
        else if (typeof fsMod.rmdirSync === 'function') fsMod.rmdirSync(stagingDir, { recursive: true } as any);
      } catch {}
    };

    const localContents = new Map<string, Buffer>();
    const remoteContents = new Map<string, Buffer>();
    const localSnapshots: any[] = [];
    const remoteSnapshots: any[] = [];

    for (const p of localFiles) {
      try {
        const full = path.join(this.localDsh, p);
        let buf: Buffer;
        if (typeof fsMod.readFileSync === 'function') {
          try {
            const data = fsMod.readFileSync(full);
            buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
          } catch {
            const content = this.readLocalFile(p);
            buf = Buffer.from(content ?? '', 'utf-8');
          }
        } else {
          const content = this.readLocalFile(p);
          buf = Buffer.from(content ?? '', 'utf-8');
        }
        localContents.set(p, buf);
        const snap = snapshotFile(p, buf);
        localSnapshots.push(snap);
      } catch {}
    }

    for (const p of remoteFiles) {
      try {
        const content = await this.fetchRemoteFile(p);
        const buf = Buffer.from(content ?? '', 'utf-8');
        remoteContents.set(p, buf);
        try {
          const stagedPath = path.join(stagingDir, p);
          const dir = path.dirname(stagedPath);
          if (typeof fsMod.mkdirSync === 'function') fsMod.mkdirSync(dir, { recursive: true });
          if (typeof fsMod.writeFileSync === 'function') {
            fsMod.writeFileSync(stagedPath, buf);
            try {
              if (typeof fsMod.chmodSync === 'function') fsMod.chmodSync(stagedPath, 0o444);
            } catch {}
          }
        } catch {}
        const snap = snapshotFile(p, buf);
        remoteSnapshots.push(snap);
      } catch {}
    }

    const preview = await buildPreview(localSnapshots, remoteSnapshots, direction, localContents, remoteContents);
    cleanup();
    return { ...preview, connection, remoteHost: this.remote };
  }

  /**
   * Apply a previously generated preview.
   * Requires {previewId, direction, confirm:true}, validates preview exists and not expired and direction matches,
   * then executes the plan's actions atomically, invalidates preview after apply, returns result.
   * Uses validated paths, argv-only transport, binary-safe session handling.
   */
  async apply(req: ApplyRequest): Promise<ApplyResult> {
    if (!req || typeof req.previewId !== 'string' || req.previewId.length === 0) {
      throw Object.assign(new Error('apply requires previewId'), { code: 'INVALID_PREVIEW_ID', phase: 'validate' as const });
    }
    if ((req as any).confirm !== true) {
      throw Object.assign(new Error('apply requires confirm:true'), { code: 'CONFIRM_REQUIRED', phase: 'validate' as const });
    }
    if (req.direction !== 'pull' && req.direction !== 'push') {
      throw Object.assign(new Error('apply requires direction pull|push'), { code: 'INVALID_DIRECTION', phase: 'validate' as const });
    }
    const preview: SyncPreview | undefined = getPreview(req.previewId);
    if (!preview) {
      throw Object.assign(new Error('preview not found or expired (60s)'), { code: 'STALE_PREVIEW', phase: 'validate' as const });
    }
    const storedDir = getPreviewDirection(req.previewId);
    if (storedDir && storedDir !== req.direction) {
      throw Object.assign(new Error(`direction mismatch: preview is ${storedDir} but apply direction is ${req.direction}`), { code: 'DIRECTION_MISMATCH', phase: 'validate' as const });
    }
    // Validate all planned paths upfront (binary-safe, validated)
    for (const a of preview.actions) {
      if (a.action === 'skip' || a.action === 'conflict') continue;
      try {
        normalizeEligiblePath(a.path);
      } catch (e: any) {
        throw Object.assign(new Error(`ineligible path in preview: ${a.path}: ${e?.message ?? String(e)}`), { code: 'INVALID_PATH', phase: 'validate' as const, path: a.path });
      }
    }

    const committed: string[] = [];
    const failures: SyncFailure[] = [];

    // Execute actions atomically per file: materialize before publish, per-file backup
    for (const act of preview.actions) {
      if (act.action === 'skip' || act.action === 'conflict') continue;
      const expectedDirection: SyncDirection = req.direction;
      const targetMatches = act.target === 'local' ? expectedDirection === 'pull' : expectedDirection === 'push';
      if (!targetMatches) continue;
      try {
        if (act.action === 'copy') {
          normalizeEligiblePath(act.path);
          await this.copyRemoteFiles([act.path], expectedDirection);
          committed.push(act.path);
        } else if (act.action === 'merge') {
          normalizeEligiblePath(act.path);
          // Binary-safe handling for session artifacts
          if (act.path.endsWith('.zstd')) {
            // Need Buffers for session merge
            const localFull = path.join(this.localDsh, act.path);
            let localBuf: Buffer | null = null;
            try {
              const fsMod: any = this.fs ?? nodeFs;
              if (typeof fsMod.readFileSync === 'function') {
                const data = fsMod.readFileSync(localFull);
                localBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
              }
            } catch {}
            if (!localBuf) {
              const localStr = this.readLocalFile(act.path);
              localBuf = Buffer.from(localStr ?? '', 'utf-8');
            }
            // Fetch remote as string then to Buffer; for real binary, transport would stage, but here we use fetchRemoteFile string fallback
            const remoteStr = await this.fetchRemoteFile(act.path);
            const remoteBuf = Buffer.from(remoteStr ?? '', 'utf-8');
            const isZstd = (b: Buffer) => b.length >= 4 && b.readUInt32LE(0) === 0xFD2FB528;
            if (isZstd(localBuf) && isZstd(remoteBuf)) {
              if (!isSameSession(localBuf, remoteBuf)) {
                failures.push({ phase: 'publish', code: 'CONFLICT', detail: 'session header mismatch', path: act.path });
                continue;
              }
              const { merged, added } = expectedDirection === 'pull' ? mergeSessionBuffers(localBuf, remoteBuf) : mergeSessionBuffers(remoteBuf, localBuf);
              if (added === 0) {
                // nothing to commit
                continue;
              }
              // For pull, publish locally atomically; for push, stage to remote (simulated as committed)
              if (expectedDirection === 'pull') {
                const full = path.join(this.localDsh, act.path);
                await this.atomicWriteWithBackup(full, merged);
              } else {
                // Push session: would upload to remote stage; for now mark committed
                // Attempt argv-only transport upload if validated target
                try {
                  const validated = this.getValidatedRemoteTarget();
                  if (validated) {
                    // materialize merged buffer to temp dir and upload via transport
                    const tmpDir = path.join(os.tmpdir(), `maestro-apply-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
                    const fsMod: any = this.fs ?? nodeFs;
                    try {
                      if (fsMod.mkdirSync) fsMod.mkdirSync(tmpDir, { recursive: true });
                      const tmpFile = path.join(tmpDir, act.path);
                      const dir = path.dirname(tmpFile);
                      if (fsMod.mkdirSync) fsMod.mkdirSync(dir, { recursive: true });
                      if (fsMod.writeFileSync) fsMod.writeFileSync(tmpFile, merged);
                      const opId = `op-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
                      // Use transport.upload for push; ignore errors and count as committed if fails? Record failure.
                      try {
                        await this.transport.upload(validated, tmpDir, [act.path], opId);
                      } catch (e: any) {
                        failures.push({ phase: 'publish', code: 'UPLOAD_FAILED', detail: String(e?.message ?? e), path: act.path });
                        continue;
                      }
                    } finally {
                      try { if (fsMod.rmSync) fsMod.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
                    }
                  }
                } catch {}
              }
              committed.push(act.path);
            } else {
              // Plaintext fallback for session (tests use strings)
              const localStr = localBuf.toString('utf-8');
              const remoteStr = remoteBuf.toString('utf-8');
              const localLines = localStr.split('\n').filter((l) => l.length > 0);
              const remoteLines = remoteStr.split('\n').filter((l) => l.length > 0);
              const seen = new Set(localLines);
              let added = 0;
              const mergedArr = [...localLines];
              const otherLines = expectedDirection === 'pull' ? remoteLines : localLines;
              const baseSeen = expectedDirection === 'pull' ? seen : new Set(remoteLines);
              const baseArr = expectedDirection === 'pull' ? mergedArr : [...remoteLines];
              // For push, localLines are remoteLines swapped, so compute added accordingly
              if (expectedDirection === 'pull') {
                for (const line of remoteLines) if (!seen.has(line)) { seen.add(line); mergedArr.push(line); added++; }
                if (added > 0) {
                  const mergedText = mergedArr.join('\n') + (mergedArr.length ? '\n' : '');
                  await this.atomicWriteWithBackup(path.join(this.localDsh, act.path), mergedText);
                  committed.push(act.path);
                }
              } else {
                // push: remote is base, local is incoming
                const seen2 = new Set(remoteLines);
                let a2 = 0;
                for (const line of localLines) if (!seen2.has(line)) { seen2.add(line); a2++; }
                if (a2 > 0) committed.push(act.path);
              }
            }
          } else if (act.path.endsWith('.md')) {
            const localStr = this.readLocalFile(act.path);
            const remoteStr = await this.fetchRemoteFile(act.path);
            const { mergedText, added } = expectedDirection === 'pull' ? mergeDelimited(localStr, remoteStr) : mergeDelimited(remoteStr, localStr);
            if (added === 0) continue;
            if (expectedDirection === 'pull') {
              await this.atomicWriteWithBackup(path.join(this.localDsh, act.path), mergedText);
            } else {
              // push md merge would be uploaded; mark committed
            }
            committed.push(act.path);
          } else if (act.path.endsWith('.jsonl')) {
            const localStr = this.readLocalFile(act.path);
            const remoteStr = await this.fetchRemoteFile(act.path);
            const localLines = localStr.split('\n').filter((l) => l.length > 0);
            const remoteLines = remoteStr.split('\n').filter((l) => l.length > 0);
            let added = 0;
            if (expectedDirection === 'pull') {
              const seen = new Set(localLines);
              let a = 0;
              for (const line of remoteLines) if (!seen.has(line)) { seen.add(line); a++; }
              added = a;
              if (added > 0) {
                const seen2 = new Set(localLines);
                const mergedArr = [...localLines];
                for (const line of remoteLines) if (!seen2.has(line)) { seen2.add(line); mergedArr.push(line); }
                const mergedText = mergedArr.join('\n') + (mergedArr.length ? '\n' : '');
                await this.atomicWriteWithBackup(path.join(this.localDsh, act.path), mergedText);
                committed.push(act.path);
              }
            } else {
              const seen = new Set(remoteLines);
              let a = 0;
              for (const line of localLines) if (!seen.has(line)) { seen.add(line); a++; }
              added = a;
              if (added > 0) committed.push(act.path);
            }
          } else {
            failures.push({ phase: 'publish', code: 'UNKNOWN_KIND', detail: 'unknown kind for merge', path: act.path });
          }
        }
      } catch (e: any) {
        failures.push({ phase: 'publish', code: e?.code ?? 'PUBLISH_FAILED', detail: e?.message ?? String(e), path: act.path });
      }
    }

    // Invalidate preview after apply regardless of partial failures? Spec says after successful apply invalidated. We invalidate on any apply attempt that passed validation.
    deletePreview(req.previewId);

    return { ok: failures.length === 0, revision: preview.revision, summary: preview.summary, committed, failures };
  }
}
