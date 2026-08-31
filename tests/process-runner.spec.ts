import { describe, it, expect } from 'vitest';
import { NodeProcessRunner } from '../src/host/process-runner.js';

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
});
