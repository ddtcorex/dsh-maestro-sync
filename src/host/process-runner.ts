import { spawn } from 'node:child_process';

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface ProcessRunner {
  run(file: string, args: readonly string[], options?: { input?: Buffer; timeoutMs?: number; onLine?: (line: string) => void }): Promise<ProcessResult>;
}

/** Maximum combined output before we kill the child (fail-closed, avoids OOM). */
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

export class NodeProcessRunner implements ProcessRunner {
  async run(file: string, args: readonly string[], options?: { input?: Buffer; timeoutMs?: number; onLine?: (line: string) => void }): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve, reject) => {
      // argv-only, never shell — caller may pass filenames with spaces/metachars as single argv items
      const child = spawn(file, args as string[], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let timeout: NodeJS.Timeout | undefined;
      let timedOut = false;
      let killedForBounds = false;
      // line-buffered stdout delivery for progress callbacks (ssh sha256sum streaming)
      let lineBuf = '';

      const killForBounds = () => {
        if (killedForBounds) return;
        killedForBounds = true;
        try { child.kill('SIGKILL'); } catch {}
      };

      if (options?.timeoutMs) {
        timeout = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch {}
        }, options.timeoutMs);
      }

      const deliverLines = () => {
        if (!options?.onLine) return;
        let idx: number;
        while ((idx = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, idx).replace(/\r$/, '');
          lineBuf = lineBuf.slice(idx + 1);
          if (line.trim()) options.onLine?.(line);
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        const buf = Buffer.from(chunk);
        stdoutLen += buf.length;
        if (stdoutLen > MAX_BUFFER_BYTES) {
          killForBounds();
          return;
        }
        stdoutChunks.push(buf);
        if (options?.onLine) {
          lineBuf += buf.toString('utf-8');
          deliverLines();
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const buf = Buffer.from(chunk);
        stderrLen += buf.length;
        if (stdoutLen + stderrLen > MAX_BUFFER_BYTES) {
          killForBounds();
          return;
        }
        stderrChunks.push(buf);
      });

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
        if (killedForBounds) {
          reject(new Error(`process "${file}" output exceeded ${MAX_BUFFER_BYTES} bytes`));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          exitCode: code ?? 0,
        });
      });

      if (options?.input) {
        try { child.stdin?.write(options.input); } catch {}
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
