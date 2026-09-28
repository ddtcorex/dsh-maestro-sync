import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { NodeProcessRunner } from '../src/host/process-runner.js';

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
  const stream = () => Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const child: any = {
    pid: 4242,
    stdout: stream(),
    stderr: stream(),
    stdin: { write: vi.fn(), end: vi.fn() },
    on(event: string, fn: (...a: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return child;
    },
    emit(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    kill: vi.fn(() => true),
  };
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

  it('does not flip to success when a late close arrives', async () => {
    const child = fakeChild();
    const runner = new NodeProcessRunner({ spawn: (() => child) as any });
    const outcome = await outcomeOf(runner.run('ssh', ['nowhere'], { timeoutMs: 50 }), 1500);
    child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(outcome).toMatch(/^rejected: /);
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
    child.stdin = { write: () => { throw new Error('EPIPE'); }, end: vi.fn() };
    const runner = new NodeProcessRunner({ spawn: (() => child) as any });
    const pending = runner.run('ssh', ['slow'], { input: Buffer.from('x') });
    pending.catch(() => {});
    expect(await outcomeOf(pending, 300)).toBe('still-pending');
  });
});
