// src/host/ssh-mux.ts — per-operation SSH ControlMaster multiplexing.
//
// One backgrounded master (`ssh -S <socket> -o ControlMaster=yes -f -N`) owns
// the connection; every subsequent spawn in the operation passes `-S <socket>`
// (ssh slaves) or `rsync -e "ssh -S <socket>"` (single validated argv) so a
// multi-spawn flow pays one handshake. The socket lives in a private 0700 dir
// and is torn down with `-O exit`; a dead master degrades to a fresh handshake.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProcessRunner } from './process-runner.js';

export interface SshMux {
  socketPath: string;
  sshArgs: string[];
  rsyncRsh: string;
  dispose(): Promise<void>;
}

function sanitizeHost(host: string): string {
  return host.replace(/[^A-Za-z0-9._-]/g, '_');
}

export async function openSshMux(opts: { host: string; baseDir: string; runner: ProcessRunner }): Promise<SshMux> {
  const dir = path.join(opts.baseDir, `${sanitizeHost(opts.host)}-${Math.random().toString(16).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = path.join(dir, 'ssh.sock');
  const connectOpts = ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes'];
  // -f backgrounds the master after auth and the process exits 0, so runner.run
  // does not hang on a connection that is meant to stay alive.
  const masterArgs = ['-S', socketPath, '-o', 'ControlMaster=yes', '-o', 'ControlPersist=60', ...connectOpts, opts.host, '-f', '-N'];
  const res = await opts.runner.run('ssh', masterArgs, { timeoutMs: 8000 });
  if (res.exitCode !== 0) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    throw Object.assign(new Error(`ssh mux master failed: ${res.stderr.toString()}`), {
      phase: 'snapshot',
      code: 'MUX_FAILED',
      detail: res.stderr.toString() || `exit ${res.exitCode}`,
    });
  }
  return {
    socketPath,
    sshArgs: ['-S', socketPath],
    rsyncRsh: `ssh -S ${socketPath}`,
    dispose: async () => {
      try {
        await opts.runner.run('ssh', ['-S', socketPath, '-O', 'exit', opts.host], { timeoutMs: 5000 });
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}