import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteTarget, SyncFailure, SyncPhase } from './sync-types.js';
import type { ProcessRunner, ProcessResult } from './process-runner.js';
import { validateRemoteTarget } from './validation.js';
import { REMOTE_AGENT_REL, remoteAgentSource, verifyRemoteAgentSource } from './remote-agent.js';

export interface SyncTransport {
  /** Resolve the remote user's $HOME as raw bytes (preflight, never shell ~ expansion). */
  remoteHome(target: { host: string }): Promise<string>;
  /** List files under the validated remote DSH root. */
  list(target: RemoteTarget): Promise<Buffer>;
  /**
   * Checksum-compare listed paths between the remote root and `localRoot`
   * without transferring content (rsync -rcn). Returns the relative names of
   * files that actually differ (added, content-changed) — the candidates that
   * later get staged. Bytes are never copied for identical files.
   */
  compare(target: RemoteTarget, localRoot: string, paths: readonly string[]): Promise<Buffer>;
  /** Rsync one batched --files-from stage of validated relative paths into `destination`. */
  stage(target: RemoteTarget, paths: readonly string[], destination: string): Promise<void>;
  /**
   * Checksum + size every remote path without transferring content (one ssh,
   * streaming one "sha\tsize\tpath" line per file as each completes). Used by
   * preview to count session changes without rsync staging remote bytes.
   */
  hashes(target: RemoteTarget, paths: readonly string[], onFile?: (h: { path: string; sha256: string; size: number }) => void): Promise<{ path: string; sha256: string; size: number }[]>;
  /** Upload materialized bytes for one operation into the remote private stage dir. */
  upload(target: RemoteTarget, source: string, paths: readonly string[], operationId: string): Promise<void>;
  /** Install the fixed remote CAS helper under `<root>/.maestro-sync/bin`. */
  ensureAgent(target: RemoteTarget): Promise<void>;
  /** Run the fixed remote helper with `operationId`; the JSONL manifest is the only input. */
  commit(target: RemoteTarget, operationId: string, manifest: Buffer): Promise<void>;
}

function failure(phase: SyncPhase, code: string, detail: string, path?: string): SyncFailure {
  return { phase, code, detail, path };
}

function toFailure(phase: SyncPhase, result: ProcessResult, file: string): SyncFailure {
  const detail = result.stderr.toString('utf-8') || `exit ${result.exitCode}`;
  return failure(phase, 'TRANSPORT_ERROR', `${file} failed: ${detail}`);
}

export class SshRsyncTransport implements SyncTransport {
  constructor(private readonly runner: ProcessRunner) {}

  async remoteHome(target: { host: string }): Promise<string> {
    if (!target || typeof target.host !== 'string' || target.host.length === 0) {
      throw Object.assign(new Error('remoteHome requires a non-empty host'), failure('validate', 'INVALID_HOST', 'remoteHome requires a non-empty host'));
    }
    // Preflight: `printf %s '$HOME'` over ssh returns the remote home as bytes.
    const result = await this.runner.run('ssh', [target.host, 'printf', '%s', '$HOME'], { timeoutMs: 8000 });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`remoteHome failed: ${result.stderr.toString()}`), failure('validate', 'REMOTE_HOME_FAILED', result.stderr.toString()));
    }
    const home = result.stdout.toString('utf-8').trim();
    if (!home || !home.startsWith('/')) {
      throw Object.assign(new Error(`invalid remote home: ${JSON.stringify(home)}`), failure('validate', 'INVALID_REMOTE_HOME', String(home)));
    }
    return home;
  }

  async list(target: RemoteTarget): Promise<Buffer> {
    const validated = validateRemoteTarget(target);
    // dshRoot is strictly validated (absolute, [A-Za-z0-9._-/], no meta), so it is
    // safe as argv items of the remote `find` command. Only the eligible subtrees
    // are walked; node_modules/profiles/.supervisor are pruned so a real ~/.dsh
    // lists in seconds. Discovered file names are never interpolated here — the
    // manifest is staged via --files-from instead.
    const remoteCmd =
      `find ${validated.dshRoot}/memories ${validated.dshRoot}/sessions ` +
      `\\( -name node_modules -o -name .git -o -name .supervisor -o -name profiles \\) -prune -o -type f -print`;
    const result = await this.runner.run('ssh', [validated.host, remoteCmd], { timeoutMs: 60000 });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`list failed: ${result.stderr.toString()}`), failure('snapshot', 'LIST_FAILED', result.stderr.toString()));
    }
    return result.stdout;
  }

  async compare(target: RemoteTarget, localRoot: string, paths: readonly string[]): Promise<Buffer> {
    const validated = validateRemoteTarget(target);
    if (paths.length === 0) return Buffer.alloc(0);
    const tmp = await mkdtemp(join(tmpdir(), 'maestro-compare-'));
    try {
      const listFile = join(tmp, 'files.txt');
      await writeFile(listFile, paths.join('\n') + '\n', 'utf-8');
      const result = await this.runner.run(
        'rsync',
        ['-rcn', `--out-format=%n`, `--files-from=${listFile}`, `${validated.host}:${validated.dshRoot}/`, localRoot.endsWith('/') ? localRoot : localRoot + '/'],
        { timeoutMs: 60000 },
      );
      // 0 = ok; 23/24 = partial/hidden files (vanished) — stdout still lists the diffs.
      if (result.exitCode !== 0 && result.exitCode !== 23 && result.exitCode !== 24) {
        throw Object.assign(new Error(`compare failed: ${result.stderr.toString()}`), failure('snapshot', 'COMPARE_FAILED', result.stderr.toString()));
      }
      return result.stdout;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async stage(target: RemoteTarget, paths: readonly string[], destination: string): Promise<void> {
    const validated = validateRemoteTarget(target);
    if (paths.length === 0) return;
    const tmp = await mkdtemp(join(tmpdir(), 'maestro-stage-'));
    try {
      const listFile = join(tmp, 'files.txt');
      await writeFile(listFile, paths.join('\n') + '\n', 'utf-8');
      const result = await this.runner.run(
        'rsync',
        ['-az', '--files-from=' + listFile, `${validated.host}:${validated.dshRoot}/`, destination + '/'],
        // SSH transfers of hundreds of small session files need more than 2 min
        // on real links (3.5s latency × N round-trips); 5 min keeps preview/apply
        // usable while still failing closed when the link is actually down.
        { timeoutMs: 300000 },
      );
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(`stage failed: ${result.stderr.toString()}`), failure('stage', 'STAGE_FAILED', result.stderr.toString()));
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async hashes(target: RemoteTarget, paths: readonly string[], onFile?: (h: { path: string; sha256: string; size: number }) => void): Promise<{ path: string; sha256: string; size: number }[]> {
    const validated = validateRemoteTarget(target);
    if (paths.length === 0) return [];
    // One ssh session; relative paths stream over stdin inside `while read`
    // (quotable, no interpolation into the shell), so every eligible file — no
    // matter its name — is hashed safely. Each completed file emits exactly one
    // "sha\tsize\tpath" line, which the runner delivers as a progress tick.
    const cmd =
      `cd ${validated.dshRoot} && while IFS= read -r f; do ` +
      `[ -n "$f" ] || continue; ` +
      `h=$(sha256sum -- "$f" 2>/dev/null | awk '{print $1}'); ` +
      `s=$(wc -c < "$f" 2>/dev/null || echo 0); ` +
      `printf '%s\\t%s\\t%s\\n' "$h" "$s" "$f"; ` +
      `done`;
    const out: { path: string; sha256: string; size: number }[] = [];
    const result = await this.runner.run('ssh', [validated.host, cmd], {
      input: Buffer.from(paths.join('\n') + '\n', 'utf-8'),
      timeoutMs: 300000,
      onLine: (line) => {
        const [sha256, sizeRaw, ...rest] = line.split('\t');
        const p = rest.join('\t');
        const size = Number(sizeRaw);
        if (!sha256 || !p || !Number.isFinite(size)) return;
        const entry = { path: p, sha256, size };
        out.push(entry);
        onFile?.(entry);
      },
    });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`hashes failed: ${result.stderr.toString()}`), failure('snapshot', 'HASH_FAILED', result.stderr.toString()));
    }
    return out;
  }

  async upload(target: RemoteTarget, source: string, paths: readonly string[], operationId: string): Promise<void> {
    const validated = validateRemoteTarget(target);
    if (paths.length === 0) return;
    const remoteStage = `${validated.dshRoot}/.maestro-sync/stage/${operationId}`;
    const mkdirResult = await this.runner.run('ssh', [validated.host, 'mkdir', '-p', remoteStage], { timeoutMs: 8000 });
    if (mkdirResult.exitCode !== 0) {
      throw Object.assign(new Error(`mkdir failed: ${mkdirResult.stderr.toString()}`), failure('publish', 'UPLOAD_FAILED', mkdirResult.stderr.toString()));
    }
    const tmp = await mkdtemp(join(tmpdir(), 'maestro-upload-'));
    try {
      const listFile = join(tmp, 'files.txt');
      await writeFile(listFile, paths.join('\n') + '\n', 'utf-8');
      const result = await this.runner.run(
        'rsync',
        ['-az', '--files-from=' + listFile, source + '/', `${validated.host}:${remoteStage}/`],
        { timeoutMs: 300000 },
      );
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(`upload failed: ${result.stderr.toString()}`), failure('publish', 'UPLOAD_FAILED', result.stderr.toString()));
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async ensureAgent(target: RemoteTarget): Promise<void> {
    const validated = validateRemoteTarget(target);
    const agentPath = `${validated.dshRoot}/${REMOTE_AGENT_REL}`;
    const agentDir = `${validated.dshRoot}/.maestro-sync/bin`;
    const source = verifyRemoteAgentSource(remoteAgentSource());
    // mkdir -p the private bin dir, then stream the fixed helper via stdin (argv-only).
    const mkdirResult = await this.runner.run('ssh', [validated.host, 'mkdir', '-p', agentDir], { timeoutMs: 8000 });
    if (mkdirResult.exitCode !== 0) {
      throw Object.assign(new Error(`ensureAgent mkdir failed: ${mkdirResult.stderr.toString()}`), failure('publish', 'AGENT_INSTALL_FAILED', mkdirResult.stderr.toString()));
    }
    const installResult = await this.runner.run('ssh', [validated.host, `cat > ${agentPath}`], { input: Buffer.from(source, 'utf-8'), timeoutMs: 8000 });
    if (installResult.exitCode !== 0) {
      throw Object.assign(new Error(`ensureAgent install failed: ${installResult.stderr.toString()}`), failure('publish', 'AGENT_INSTALL_FAILED', installResult.stderr.toString()));
    }
    const chmodResult = await this.runner.run('ssh', [validated.host, 'chmod', '700', agentPath], { timeoutMs: 8000 });
    if (chmodResult.exitCode !== 0) {
      throw Object.assign(new Error(`ensureAgent chmod failed: ${chmodResult.stderr.toString()}`), failure('publish', 'AGENT_INSTALL_FAILED', chmodResult.stderr.toString()));
    }
  }

  async commit(target: RemoteTarget, operationId: string, manifest: Buffer): Promise<void> {
    const validated = validateRemoteTarget(target);
    // Fixed protocol command: the helper path is a validated constant under the
    // validated root; operationId is a locally generated hex id. The manifest on
    // stdin is the only carrier of discovered paths.
    const result = await this.runner.run(
      'ssh',
      [validated.host, `${validated.dshRoot}/${REMOTE_AGENT_REL}`, operationId],
      { input: manifest, timeoutMs: 15000 },
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString('utf-8');
      const code = stderr.includes('CONCURRENT_MODIFICATION') ? 'CONCURRENT_MODIFICATION' : 'COMMIT_FAILED';
      throw Object.assign(new Error(`commit failed: ${stderr || `exit ${result.exitCode}`}`), failure('publish', code, stderr || `exit ${result.exitCode}`));
    }
  }
}

export function createTransport(runner: ProcessRunner): SyncTransport {
  return new SshRsyncTransport(runner);
}