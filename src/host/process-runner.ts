import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface ProcessRunner {
  run(file: string, args: readonly string[], options?: { input?: Buffer; timeoutMs?: number }): Promise<ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  async run(file: string, args: readonly string[], options?: { input?: Buffer; timeoutMs?: number }): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(file, args as string[], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timeout: NodeJS.Timeout | undefined;
      let timedOut = false;

      if (options?.timeoutMs) {
        timeout = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs);
      }

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));

      child.on('error', (err) => {
        if (timeout) clearTimeout(timeout);
        reject(err);
      });

      child.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        if (timedOut) {
          reject(new Error(`process "${file} ${args.join(' ')}" timed out after ${options?.timeoutMs}ms`));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          exitCode: code ?? 0,
        });
      });

      if (options?.input) {
        child.stdin?.write(options.input);
        child.stdin?.end();
      } else {
        child.stdin?.end();
      }
    });
  }
}

export function createProcessRunner(): ProcessRunner {
  return new NodeProcessRunner();
}
