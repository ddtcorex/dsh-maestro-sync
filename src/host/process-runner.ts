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

export interface NodeProcessRunnerOptions {
  /**
   * Injectable spawn. Tests need a child that never emits `'close'` (a
   * grandchild holding the stdio pipes does that for real), which no real
   * process can reproduce deterministically.
   */
  spawn?: typeof spawn;
}

export class NodeProcessRunner implements ProcessRunner {
  private readonly spawnChild: typeof spawn;

  constructor(options: NodeProcessRunnerOptions = {}) {
    this.spawnChild = options.spawn ?? spawn;
  }

  async run(file: string, args: readonly string[], options?: { input?: Buffer; timeoutMs?: number; onLine?: (line: string) => void }): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve, reject) => {
      // argv-only, never shell — caller may pass filenames with spaces/metachars as single argv items
      // Detached on POSIX so the child leads its own process group; killTree() needs
      // that to reach the grandchildren it spawns.
      const child = this.spawnChild(file, args as string[], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let timeout: NodeJS.Timeout | undefined;
      let settled = false;
      // line-buffered stdout delivery for progress callbacks (ssh sha256sum streaming)
      let lineBuf = '';

      /**
       * Single owner of the promise's fate.
       *
       * The timeout, `'error'` and `'close'` race for it and the first caller
       * wins; later ones are dropped. Without that, a child that finally closes
       * after a timeout kill would resolve a promise the caller was already told
       * failed. Every path clears the timer here, so no branch can leave one
       * armed.
       */
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        finish();
      };

      /**
       * Kill the child and the processes it spawned.
       *
       * SIGKILL to the direct child alone leaves its grandchildren alive while
       * they keep the inherited stdio open — ssh's `ProxyCommand cloudflared
       * access ssh` and git's `git-remote-https` are the real cases — so the
       * timeout stops bounding anything. POSIX: the child is spawned detached,
       * so it leads its own process group and `-pid` reaches the whole tree.
       * Windows has no process-group signal and no SIGKILL semantics, so only
       * the child is killed there: the caller is still never stuck, but a
       * grandchild may outlive the call.
       */
      const killTree = () => {
        if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
          try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through to the direct kill */ }
        }
        try { child.kill('SIGKILL'); } catch {}
      };

      /**
       * Kill, then release the pipes. Order is load-bearing: destroying the
       * stdio streams can make Node emit `'close'`, so the outcome must already
       * be settled or that `'close'` would resolve a fake success.
       */
      const teardown = () => {
        killTree();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const killForBounds = () => {
        if (settled) return;
        settle(() => reject(new Error(`process "${file}" output exceeded ${MAX_BUFFER_BYTES} bytes`)));
        teardown();
      };

      if (options?.timeoutMs) {
        const timeoutMs = options.timeoutMs;
        timeout = setTimeout(() => {
          // Reject at the deadline instead of waiting for `'close'`: a grandchild
          // that inherited the pipes keeps `'close'` from firing at all, which is
          // what made this "timeout" unbounded.
          settle(() => reject(new Error(`process "${file} ${args.join(' ')}" timed out after ${timeoutMs}ms`)));
          teardown();
        }, timeoutMs);
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
        settle(() => reject(err));
      });

      child.on('close', (code) => {
        settle(() => resolve({
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          exitCode: code ?? 0,
        }));
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
