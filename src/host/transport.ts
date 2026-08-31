import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteTarget, SyncFailure, SyncPhase } from './sync-types.js';
import type { ProcessRunner, ProcessResult } from './process-runner.js';
import { validateRemoteTarget } from './validation.js';

export interface SyncTransport {
  remoteHome(target: RemoteTarget): Promise<string>;
  list(target: RemoteTarget): Promise<Buffer>;
  stage(target: RemoteTarget, paths: readonly string[], destination: string): Promise<void>;
  upload(target: RemoteTarget, source: string, paths: readonly string[], operationId: string): Promise<void>;
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

  async remoteHome(target: RemoteTarget): Promise<string> {
    const validated = validateRemoteTarget(target);
    const result = await this.runner.run('ssh', [validated.host, 'printf', '%s', '$HOME'], { timeoutMs: 8000 });
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
    // Use ssh to run find on remote DSH root, output null-separated or newline
    const remoteCmd = `find ${validated.dshRoot} -type f -print`;
    const result = await this.runner.run('ssh', [validated.host, remoteCmd], { timeoutMs: 15000 });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`list failed: ${result.stderr.toString()}`), failure('snapshot', 'LIST_FAILED', result.stderr.toString()));
    }
    return result.stdout;
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
        ['-avz', '--files-from=' + listFile, `${validated.host}:${validated.dshRoot}/`, destination + '/'],
        { timeoutMs: 30000 },
      );
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(`stage failed: ${result.stderr.toString()}`), failure('stage', 'STAGE_FAILED', result.stderr.toString()));
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async upload(target: RemoteTarget, source: string, paths: readonly string[], operationId: string): Promise<void> {
    const validated = validateRemoteTarget(target);
    if (paths.length === 0) return;
    const remoteStage = `${validated.dshRoot}/.maestro-sync/stage/${operationId}`;
    // Ensure remote stage dir exists
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
        ['-avz', '--files-from=' + listFile, source + '/', `${validated.host}:${remoteStage}/`],
        { timeoutMs: 30000 },
      );
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(`upload failed: ${result.stderr.toString()}`), failure('publish', 'UPLOAD_FAILED', result.stderr.toString()));
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async commit(target: RemoteTarget, operationId: string, manifest: Buffer): Promise<void> {
    const validated = validateRemoteTarget(target);
    const result = await this.runner.run(
      'ssh',
      [validated.host, 'maestro-sync-commit', operationId],
      { input: manifest, timeoutMs: 15000 },
    );
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`commit failed: ${result.stderr.toString()}`), failure('publish', 'COMMIT_FAILED', result.stderr.toString()));
    }
  }
}

export function createTransport(runner: ProcessRunner): SyncTransport {
  return new SshRsyncTransport(runner);
}
