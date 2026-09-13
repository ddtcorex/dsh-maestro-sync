import { describe, it, expect, vi } from 'vitest';
import { SshRsyncTransport } from '../src/host/transport.js';
import type { ProcessRunner } from '../src/host/process-runner.js';

function makeRunner(overrides: Partial<Record<string, any>> = {}): ProcessRunner {
  const mock = {
    run: vi.fn(async (file: string, args: readonly string[]) => {
      if (overrides[file]) return overrides[file](file, args);
      if (file === 'ssh' && args.includes('printf')) {
        return { stdout: Buffer.from('/home/kai'), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      if (file === 'ssh' && args.some((a) => String(a).includes('find'))) {
        return { stdout: Buffer.from('dsh-maestro-memory/a.md\ndsh-maestro-memory/b.md\n'), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      if (file === 'rsync') {
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    }),
  } as unknown as ProcessRunner;
  return mock;
}

describe('transport', () => {
  it('remoteHome returns validated absolute path as bytes', async () => {
    const runner = makeRunner();
    const transport = new SshRsyncTransport(runner);
    const home = await transport.remoteHome({ host: 'sync-host' });
    expect(home).toBe('/home/kai');
    expect(runner.run).toHaveBeenCalledWith('ssh', expect.arrayContaining(['sync-host']), expect.anything());
  });

  it('remoteHome retries once after a transient ssh timeout', async () => {
    let calls = 0;
    const runner: ProcessRunner = {
      run: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('process "ssh sync-host printf %s $HOME" timed out after 8000ms');
        return { stdout: Buffer.from('/home/kai'), stderr: Buffer.alloc(0), exitCode: 0 };
      }),
    } as unknown as ProcessRunner;
    const transport = new SshRsyncTransport(runner);
    await expect(transport.remoteHome({ host: 'sync-host' })).resolves.toBe('/home/kai');
    expect(calls).toBe(2);
  });

  it('remoteHome still fails closed after the retry is exhausted', async () => {
    const runner: ProcessRunner = {
      run: vi.fn(async () => { throw new Error('timed out'); }),
    } as unknown as ProcessRunner;
    const transport = new SshRsyncTransport(runner);
    await expect(transport.remoteHome({ host: 'sync-host' })).rejects.toThrow();
    expect((runner.run as any).mock.calls.length).toBe(2);
  });

  it('propagates non-zero rsync failure with stderr', async () => {
    const runner: ProcessRunner = {
      run: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('no such file'), exitCode: 23 })),
    } as unknown as ProcessRunner;
    const transport = new SshRsyncTransport(runner);
    await expect(transport.stage({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, ['dsh-maestro-memory/a.md'], '/tmp/dest')).rejects.toMatchObject({ phase: 'stage' });
  });

  it('stage uses single rsync with files-from and preserves binary', async () => {
    const runner = makeRunner();
    const transport = new SshRsyncTransport(runner);
    await transport.stage({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, ['dsh-maestro-memory/a.md', 'sessions/x/y/session.jsonl.zstd'], '/tmp/dest');
    const rsyncCalls = (runner.run as any).mock.calls.filter(([f]: any) => f === 'rsync');
    expect(rsyncCalls.length).toBe(1);
    const args = rsyncCalls[0][1] as string[];
    expect(args.join(' ')).toContain('--files-from=');
    expect(args.join(' ')).toContain('sync-host:/home/kai/.dsh/');
  });

  it('rejects unsafe remote target before spawn', async () => {
    const runner = makeRunner();
    const transport = new SshRsyncTransport(runner);
    await expect(transport.manifest({ host: 'host;id', dshRoot: '/home/kai/.dsh' })).rejects.toThrow();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('manifest runs one ssh with the fixed script and parses NUL-framed stdout', async () => {
    const entries = [
      { path: 'dsh-maestro-memory/daily/a.md', sha256: 'a'.repeat(64), size: 5, mtimeSec: 1 },
      { path: 'sessions/x/y/session.jsonl.zstd', sha256: 'b'.repeat(64), size: 7, mtimeSec: 2 },
    ];
    const runner: ProcessRunner = {
      run: vi.fn(async (_file: string, args: readonly string[]) => {
        const cmd = args.join(' ');
        if (cmd.includes('sha256sum')) {
          return { stdout: Buffer.from(entries.map((e) => `${e.sha256}\t${e.size}\t${e.mtimeSec}\t${e.path}\0`).join(''), 'utf-8'), stderr: Buffer.alloc(0), exitCode: 0 };
        }
        if (cmd.includes('printf')) return { stdout: Buffer.from('/home/kai'), stderr: Buffer.alloc(0), exitCode: 0 };
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      }),
    } as unknown as ProcessRunner;
    const transport = new SshRsyncTransport(runner);
    const out = await transport.manifest({ host: 'sync-host', dshRoot: '/home/kai/.dsh' });
    expect(out.length).toBe(2);
    expect(out[0]!.path).toBe('dsh-maestro-memory/daily/a.md');
    expect(out[1]!.sha256).toBe('b'.repeat(64));
    expect((runner.run as any).mock.calls[0][0]).toBe('ssh');
  });

  it('readMachineId trims agent output and returns null on failure', async () => {
    const run = vi.fn(async () => ({ stdout: Buffer.from('machine-b\n'), stderr: Buffer.alloc(0), exitCode: 0 }));
    const transport = new SshRsyncTransport({ run } as any);
    expect(await transport.readMachineId({ host: 'sync-host', dshRoot: '/home/kai/.dsh' })).toBe('machine-b');
    expect(run).toHaveBeenCalledWith('ssh', expect.arrayContaining(['sync-host', '/home/kai/.dsh/.maestro-sync/bin/maestro-sync-commit', 'machine-id']), expect.anything());
    const failing = new SshRsyncTransport({ run: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('x'), exitCode: 1 })) } as any);
    expect(await failing.readMachineId({ host: 'sync-host', dshRoot: '/home/kai/.dsh' })).toBeNull();
  });

  it('patchRemoteTunnel parses PATCHED/UNCHANGED and throws otherwise', async () => {
    const sha = 'a'.repeat(64);
    const ok = new SshRsyncTransport({ run: vi.fn(async () => ({ stdout: Buffer.from(`PATCHED ${sha}\n`), stderr: Buffer.alloc(0), exitCode: 0 })) } as any);
    expect(await ok.patchRemoteTunnel({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, 'machine-b')).toEqual({ changed: true, sha256: sha });
    const same = new SshRsyncTransport({ run: vi.fn(async () => ({ stdout: Buffer.from(`UNCHANGED ${sha}\n`), stderr: Buffer.alloc(0), exitCode: 0 })) } as any);
    expect(await same.patchRemoteTunnel({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, 'machine-b')).toEqual({ changed: false, sha256: sha });
    const bad = new SshRsyncTransport({ run: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('nope'), exitCode: 1 })) } as any);
    await expect(bad.patchRemoteTunnel({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, 'machine-b')).rejects.toThrow();
  });
});
