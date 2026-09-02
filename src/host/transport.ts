import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteTarget, SyncFailure, SyncPhase } from './sync-types.js';
import type { ProcessRunner, ProcessResult } from './process-runner.js';
import { validateRemoteTarget } from './validation.js';
import { REMOTE_AGENT_REL, remoteAgentSource, verifyRemoteAgentSource } from './remote-agent.js';
import { buildRemoteManifestScript, parseRemoteManifest, type RemoteManifestEntry } from './remote-manifest.js';
import { buildWarmCacheScript } from './remote-cache.js';

export interface SyncTransport {
  /** Resolve the remote user's $HOME as raw bytes (preflight, never shell ~ expansion). */
  remoteHome(target: { host: string }): Promise<string>;
  /** Rsync one batched --files-from stage of validated relative paths into `destination`. */
  stage(target: RemoteTarget, paths: readonly string[], destination: string): Promise<void>;
  /**
   * One-pass remote inventory: a single ssh runs the fixed NUL-framed manifest
   * script and returns validated eligible entries (path/sha256/size/mtimeSec)
   * — replaces find + rsync -rcn compare + session hashes for inventory.
   */
  manifest(target: RemoteTarget): Promise<RemoteManifestEntry[]>;
  /**
   * Refresh the remote fingerprint cache (<root>/.maestro-sync/fp.tsv, atomic
   * tmp+rename). NEVER called from preview — only from the push-apply path
   * (which already writes the remote) or an explicit warm command.
   */
  warmCache(target: RemoteTarget): Promise<void>;
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

  async manifest(target: RemoteTarget): Promise<RemoteManifestEntry[]> {
    const validated = validateRemoteTarget(target);
    // One ssh runs the fixed NUL-framed manifest script (find + sha256sum +
    // stat in a single pass); every returned path is validated by the parser
    // before it can enter a plan. This replaces list + compare + hashes for
    // inventory: one remote byte pass, one spawn.
    const result = await this.runner.run('ssh', [validated.host, buildRemoteManifestScript(validated.dshRoot)], { timeoutMs: 300000 });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`manifest failed: ${result.stderr.toString()}`), failure('snapshot', 'MANIFEST_FAILED', result.stderr.toString()));
    }
    return parseRemoteManifest(result.stdout);
  }

  async warmCache(target: RemoteTarget): Promise<void> {
    const validated = validateRemoteTarget(target);
    // Refreshes <root>/.maestro-sync/fp.tsv atomically on the remote. Only the
    // push-apply path (post-commit) or an explicit warm command calls this —
    // preview must stay strictly read-only.
    const result = await this.runner.run('ssh', [validated.host, buildWarmCacheScript(validated.dshRoot)], { timeoutMs: 300000 });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`warmCache failed: ${result.stderr.toString()}`), failure('snapshot', 'WARM_FAILED', result.stderr.toString()));
    }
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