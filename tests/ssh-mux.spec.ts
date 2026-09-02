// tests/ssh-mux.spec.ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openSshMux } from '../src/host/ssh-mux.js';

afterEach(() => {});

describe('ssh mux', () => {
  it('starts a backgrounded master, exposes -S args for reuse, and tears down on dispose', async () => {
    const calls: string[][] = [];
    const runner: any = {
      run: async (file: string, args: string[]) => {
        calls.push([file, ...args]);
        // simulate ssh -f: the master creates the control socket then exits
        if (args.includes('-f') || args.includes('ControlMaster=yes')) {
          const s = args[args.indexOf('-S') + 1];
          if (s) {
            fs.mkdirSync(path.dirname(s), { recursive: true });
            fs.writeFileSync(s, '');
          }
        }
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
      },
    };
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mux-'));
    const mux = await openSshMux({ host: 'sync-host', baseDir, runner });
    expect(mux.sshArgs).toContain('-S');
    expect(mux.rsyncRsh).toContain('-S');
    expect(fs.existsSync(mux.socketPath)).toBe(true);
    await mux.dispose();
    expect(calls.some((c) => c.includes('-O') && c.includes('exit'))).toBe(true);
    expect(fs.existsSync(path.dirname(mux.socketPath))).toBe(false);
  });

  it('a failing master rejects with a structured MUX_FAILED failure', async () => {
    const runner: any = {
      run: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('Connection refused'), exitCode: 255 }),
    };
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxfail-'));
    await expect(openSshMux({ host: 'sync-host', baseDir, runner })).rejects.toMatchObject({ code: 'MUX_FAILED' });
  });
});