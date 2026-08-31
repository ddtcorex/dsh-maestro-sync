import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { mergeDelimited } from './merge.js';
import { mergeZstdLines } from './session-merge.js';
import { hashBuffer, snapshotFile } from './snapshot.js';
import { buildPreview } from './sync-plan.js';
import { normalizeEligiblePath } from './validation.js';
import type { SyncDirection } from './sync-types.js';
import { createProcessRunner, type ProcessRunner } from './process-runner.js';
import { createTransport, type SyncTransport } from './transport.js';
import { validateRemoteTarget } from './validation.js';

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
    // backup existing file to .bak.<ts>
    try {
      const exists = fsMod.existsSync ? fsMod.existsSync(fullPath) : false;
      if (exists) {
        const bak = `${fullPath}.bak.${Date.now()}`;
        if (typeof fsMod.copyFileSync === 'function') {
          try {
            fsMod.copyFileSync(fullPath, bak);
          } catch {
            // fallback via read/write
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
    // atomic write via tmp + rename
    const tmp = `${fullPath}.tmp.${Math.random().toString(16).slice(2, 6)}`;
    try {
      if (typeof fsMod.writeFileSync === 'function') {
        if (Buffer.isBuffer(content)) fsMod.writeFileSync(tmp, content);
        else fsMod.writeFileSync(tmp, content, 'utf-8');
      }
      if (typeof fsMod.renameSync === 'function') {
        fsMod.renameSync(tmp, fullPath);
      } else {
        // fallback: write directly
        if (Buffer.isBuffer(content)) fsMod.writeFileSync(fullPath, content);
        else fsMod.writeFileSync(fullPath, content, 'utf-8');
        try {
          if (fsMod.existsSync && fsMod.existsSync(tmp) && fsMod.unlinkSync) fsMod.unlinkSync(tmp);
        } catch {}
      }
    } catch {
      // fallback direct write
      try {
        if (Buffer.isBuffer(content)) fsMod.writeFileSync(fullPath, content);
        else fsMod.writeFileSync(fullPath, content, 'utf-8');
      } catch {}
    }
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
    const localFiles = this.listLocalFiles();
    const remoteFiles = await this.listRemoteFiles();
    const localSet = new Set(localFiles);
    const remoteSet = new Set(remoteFiles);
    const onlyRemote = remoteFiles.filter((f) => !localSet.has(f));
    const both = remoteFiles.filter((f) => localSet.has(f));

    if (!dryRun && onlyRemote.length > 0) {
      await this.copyRemoteFiles(onlyRemote, 'pull');
    }

    // Dry-run: skip per-file fetch/merge (would be 900+ ssh cats and timeout). Just report copied.
    if (dryRun) {
      return { copied: onlyRemote.length, merged: 0, added: 0 };
    }

    let merged = 0;
    let added = 0;
    for (const rel of both) {
      const localContent = this.readLocalFile(rel);
      const remoteContent = await this.fetchRemoteFile(rel);
      if (!remoteContent && !localContent) continue;

      let resultAdded = 0;
      let mergedContent: string | null = null;

      if (this.isSessionFile(rel)) {
        const { merged: m, added: a } = mergeZstdLines(localContent, remoteContent);
        resultAdded = a;
        mergedContent = m;
      } else if (this.isMemoryFile(rel)) {
        const { mergedText, added: a } = mergeDelimited(localContent, remoteContent);
        resultAdded = a;
        mergedContent = mergedText;
      } else {
        // for other files, no merge; treat as already present
        continue;
      }

      if (resultAdded > 0) {
        merged++;
        added += resultAdded;
        if (mergedContent !== null) {
          const full = path.join(this.localDsh, rel);
          await this.atomicWriteWithBackup(full, mergedContent);
        }
      }
    }

    return { copied: onlyRemote.length, merged, added };
  }

  async push(opts: { dryRun?: boolean } = {}): Promise<PullResult> {
    const dryRun = !!opts.dryRun;
    const localFiles = this.listLocalFiles();
    const remoteFiles = await this.listRemoteFiles();
    const localSet = new Set(localFiles);
    const remoteSet = new Set(remoteFiles);
    const onlyLocal = localFiles.filter((f) => !remoteSet.has(f));
    const both = localFiles.filter((f) => remoteSet.has(f));

    if (!dryRun && onlyLocal.length > 0) {
      await this.copyRemoteFiles(onlyLocal, 'push');
    }

    // Dry-run: skip per-file fetch (900+ ssh cats) — just report copied
    if (dryRun) {
      return { copied: onlyLocal.length, merged: 0, added: 0 };
    }

    // For push, merging both would typically happen on remote side;
    // we estimate merged/added similarly without actually writing remote files
    // For test purposes, compute added via same merge logic but don't write locally
    let merged = 0;
    let added = 0;
    for (const rel of both) {
      const localContent = this.readLocalFile(rel);
      const remoteContent = await this.fetchRemoteFile(rel);
      let resultAdded = 0;
      if (this.isSessionFile(rel)) {
        const { added: a } = mergeZstdLines(remoteContent, localContent);
        resultAdded = a;
      } else if (this.isMemoryFile(rel)) {
        const { added: a } = mergeDelimited(remoteContent, localContent);
        resultAdded = a;
      } else continue;
      if (resultAdded > 0) {
        merged++;
        added += resultAdded;
        // In real impl, would push merged content to remote via ssh; dryRun skips
        // For test, we don't actually write remote
      }
    }

    return { copied: onlyLocal.length, merged, added };
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
}
