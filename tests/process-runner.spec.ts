import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessRunner } from '../src/host/process-runner.js';

const itPosix = process.platform === 'win32' ? it.skip : it;

/**
 * A child that never emits `'close'` — the real-world shape when a grandchild
 * (git's `git-remote-https`, ssh's `ProxyCommand cloudflared access ssh`)
 * inherits the stdio pipes and outlives the child we killed. Node emits
 * `'close'` only once every stdio holder is gone, so a runner that settles on
 * `'close'` alone never settles here — which is exactly the bug these cases
 * pin.
 */
function fakeChild() {
  const listeners = new Map<string, Array<(...a: any[]) => void>>();
  const child: any = {
    // `pid: 0` is deliberate: killTree() must never signal a process group it
    // did not create, and the `pid > 0` guard sends this fake down the direct
    // kill branch. A realistic-looking pid (4242) would make the suite SIGKILL
    // an unrelated group if that pgid happened to exist.
    pid: 0,
    stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    on(event: string, fn: (...a: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return child;
    },
    emit(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    kill: vi.fn(() => true),
  };
  // A real child's `'close'` fires once every stdio holder is released, so a
  // destroy-triggered close is exactly the race teardown() must not lose.
  const stream = () => {
    const s: any = new EventEmitter();
    s.destroy = () => { child.emit('close', null); };
    return s;
  };
  child.stdout = stream();
  child.stderr = stream();
  return child;
}

/**
 * Race a promise against a real-time budget. A regression must fail loudly with
 * `still-pending` instead of hanging the suite (the old runner's promise never
 * settles, so a bare `await expect(...).rejects` would stall the whole run).
 */
const outcomeOf = (p: Promise<unknown>, budgetMs: number): Promise<string> => Promise.race([
  p.then(() => 'resolved', (e: any) => `rejected: ${e?.message}`),
  new Promise<string>((r) => setTimeout(() => r('still-pending'), budgetMs)),
]);

describe('process-runner', () => {
  it('passes a filename as one rsync argv item and preserves binary stdout', async () => {
    const runner = new NodeProcessRunner();
    // Use printf to emit binary via shell:false; we test that stdout is Buffer and preserves bytes
    // Use node to emit binary: node -e "process.stdout.write(Buffer.from([0xfd,0x2f,0xb5,0x28]))"
    const result = await runner.run('node', ['-e', 'process.stdout.write(Buffer.from([0xfd,0x2f,0xb5,0x28]))']);
    expect(result.stdout).toEqual(Buffer.from([0xfd, 0x2f, 0xb5, 0x28]));
    expect(result.exitCode).toBe(0);
  });

  it('propagates non-zero exit with stderr', async () => {
    const runner = new NodeProcessRunner();
    const result = await runner.run('node', ['-e', 'console.error("oops"); process.exit(2)']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('oops');
  });

  it('times out and rejects', async () => {
    const runner = new NodeProcessRunner();
    await expect(runner.run('node', ['-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  it('sends input buffer to stdin', async () => {
    const runner = new NodeProcessRunner();
    const input = Buffer.from('hello');
    const result = await runner.run('node', ['-e', 'process.stdin.on("data", d=>process.stdout.write(d))'], { input });
    expect(result.stdout.toString()).toBe('hello');
  });

  it('rejects at its timeout even when the child never emits close', async () => {
    const child = fakeChild();
    const runner = new NodeProcessRunner({ spawn: (() => child) as any });
    const outcome = await outcomeOf(runner.run('ssh', ['nowhere'], { timeoutMs: 50 }), 1500);
    expect(outcome).toBe('rejected: process "ssh nowhere" timed out after 50ms');
    expect(child.kill).toHaveBeenCalled();
  });

  it('does not flip to success when the teardown close arrives', async () => {
    const child = fakeChild();
    const runner = new NodeProcessRunner({ spawn: (() => child) as any });
    const outcome = await outcomeOf(runner.run('ssh', ['nowhere'], { timeoutMs: 50 }), 1500);
    // teardown() already destroyed the pipes, and the fake emits 'close' from
    // destroy — so the close that could flip a rejection into a success has
    // already been delivered by the time this line runs.
    child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(outcome).toBe('rejected: process "ssh nowhere" timed out after 50ms');
  });

  it('rejects when the output bound is exceeded, without waiting for close', async () => {
    const child = fakeChild();
    const runner = new NodeProcessRunner({ spawn: (() => child) as any });
    const pending = outcomeOf(runner.run('ssh', ['flood'], { timeoutMs: 5000 }), 1500);
    child.stdout.emit('data', Buffer.alloc(21 * 1024 * 1024));
    expect(await pending).toBe('rejected: process "ssh" output exceeded 20971520 bytes');
  });

  it('stays unbounded without a timeout, and survives a dead stdin', async () => {
    const child = fakeChild();
    child.stdin = { write: () => { throw new Error('EPIPE'); }, end: vi.fn(), on: vi.fn() };
    const runner = new NodeProcessRunner({ spawn: (() => child) as any });
    const pending = runner.run('ssh', ['slow'], { input: Buffer.from('x') });
    pending.catch(() => {});
    expect(await outcomeOf(pending, 300)).toBe('still-pending');
  });

  it('does not let a dead stdin pipe reach uncaughtException', async () => {
    const runner = new NodeProcessRunner();
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      // 1 MiB, not 4 KiB: a small write usually lands in the pipe buffer before
      // the child exits (measured 1/20 attempts on this host), while 1 MiB
      // flushes into a closed pipe every time (measured 20/20) — so this pins
      // the async `'error'` path deterministically rather than by luck.
      const result = await runner.run('bash', ['-c', 'exit 0'], {
        input: Buffer.alloc(1024 * 1024),
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      await new Promise((r) => setTimeout(r, 250));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  itPosix('leaves no grandchild behind when the timeout fires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-tree-'));
    try {
      const pidFile = join(dir, 'grandchild.pid');
      const runner = new NodeProcessRunner();
      const started = Date.now();
      await expect(
        runner.run('bash', ['-c', `sleep 31.3 & echo $! > "${pidFile}"; wait`], { timeoutMs: 300 }),
      ).rejects.toThrow(/timed out after 300ms/);
      expect(Date.now() - started).toBeLessThan(5000);
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(pid).toBeGreaterThan(0);
      let alive = true;
      for (let i = 0; i < 60 && alive; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        try { process.kill(pid, 0); } catch { alive = false; }
      }
      expect(alive, `grandchild ${pid} survived the timeout kill`).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps progress lines already delivered when the timeout rejects', async () => {
    const child = fakeChild();
    const lines: string[] = [];
    const runner = new NodeProcessRunner({ spawn: (() => child) as any });
    const outcome = outcomeOf(
      runner.run('ssh', ['x'], { timeoutMs: 50, onLine: (l: string) => lines.push(l) }),
      1500,
    );
    child.stdout.emit('data', Buffer.from('first\n'));
    expect(await outcome).toMatch(/^rejected: /);
    expect(lines).toEqual(['first']);
  });
});
