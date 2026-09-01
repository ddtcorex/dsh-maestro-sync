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
        return { stdout: Buffer.from('memories/a.md\nmemories/b.md\n'), stderr: Buffer.alloc(0), exitCode: 0 };
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

  it('propagates non-zero rsync failure with stderr', async () => {
    const runner: ProcessRunner = {
      run: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('no such file'), exitCode: 23 })),
    } as unknown as ProcessRunner;
    const transport = new SshRsyncTransport(runner);
    await expect(transport.stage({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, ['memories/a.md'], '/tmp/dest')).rejects.toMatchObject({ phase: 'stage' });
  });

  it('stage uses single rsync with files-from and preserves binary', async () => {
    const runner = makeRunner();
    const transport = new SshRsyncTransport(runner);
    await transport.stage({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, ['memories/a.md', 'sessions/x/y/session.jsonl.zstd'], '/tmp/dest');
    const rsyncCalls = (runner.run as any).mock.calls.filter(([f]: any) => f === 'rsync');
    expect(rsyncCalls.length).toBe(1);
    const args = rsyncCalls[0][1] as string[];
    expect(args.join(' ')).toContain('--files-from=');
    expect(args.join(' ')).toContain('sync-host:/home/kai/.dsh/');
  });

  it('compare uses a checksum dry-run that transfers no content', async () => {
    const runner = makeRunner();
    const transport = new SshRsyncTransport(runner);
    await transport.compare({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, '/home/kai/.dsh', ['memories/a.md', 'memories/b.md']);
    const rsyncCalls = (runner.run as any).mock.calls.filter(([f]: any) => f === 'rsync');
    expect(rsyncCalls.length).toBe(1);
    const args = rsyncCalls[0][1] as string[];
    expect(args.join(' ')).toContain('-rcn');
    expect(args.join(' ')).toContain('--out-format=%n');
    expect(args.join(' ')).toContain('--files-from=');
    expect(args.join(' ')).toContain('/home/kai/.dsh/');
  });

  it('list prunes heavy dirs so a real ~/.dsh lists in seconds', async () => {
    const runner = makeRunner();
    const transport = new SshRsyncTransport(runner);
    await transport.list({ host: 'sync-host', dshRoot: '/home/kai/.dsh' });
    const sshCalls = (runner.run as any).mock.calls.filter(([f]: any) => f === 'ssh');
    expect(sshCalls.length).toBe(1);
    const cmd = sshCalls[0][1].join(' ');
    expect(cmd).toContain('/home/kai/.dsh/memories');
    expect(cmd).toContain('/home/kai/.dsh/sessions');
    expect(cmd).toContain('-prune');
    expect(cmd).toContain('node_modules');
    expect(cmd).not.toContain('find /home/kai/.dsh -type f');
  });

  it('rejects unsafe remote target before spawn', async () => {
    const runner = makeRunner();
    const transport = new SshRsyncTransport(runner);
    await expect(transport.list({ host: 'host;id', dshRoot: '/home/kai/.dsh' })).rejects.toThrow();
    expect(runner.run).not.toHaveBeenCalled();
  });
});
