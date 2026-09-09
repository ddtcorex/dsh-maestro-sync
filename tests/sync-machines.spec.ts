import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkMachines, readLocalMachineId, readRemoteMachineId } from '../src/host/machine-id.js';

describe('checkMachines', () => {
  it('pull requires from === remoteId', () => {
    const bad = checkMachines({ mode: 'pull', from: 'dsh-home', to: 'dsh-company', localId: 'dsh-home', remoteId: 'dsh-company' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/\[wrong-machine\]/);
    const good = checkMachines({ mode: 'pull', from: 'dsh-company', to: 'dsh-home', localId: 'dsh-home', remoteId: 'dsh-company' });
    expect(good).toMatchObject({ ok: true, localId: 'dsh-home', remoteId: 'dsh-company' });
  });

  it('bidirectional requires from === local && to === remote', () => {
    expect(checkMachines({ mode: 'bidirectional', from: 'dsh-home', to: 'dsh-company', localId: 'dsh-home', remoteId: 'dsh-company' }).ok).toBe(true);
    expect(checkMachines({ mode: 'bidirectional', from: 'dsh-company', to: 'dsh-home', localId: 'dsh-home', remoteId: 'dsh-company' }).ok).toBe(false);
  });

  it('unknown ids are lenient, from === to always fails', () => {
    expect(checkMachines({ mode: 'pull', from: 'dsh-home', to: 'dsh-company', localId: null, remoteId: null }).ok).toBe(true);
    const same = checkMachines({ mode: 'push', from: 'dsh-home', to: 'dsh-home', localId: 'dsh-home', remoteId: 'dsh-company' });
    expect(same.ok).toBe(false);
  });
});

describe('readLocalMachineId', () => {
  it('reads and trims the machine-id file, null when missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-id-'));
    fs.writeFileSync(path.join(dir, 'machine-id'), 'dsh-home\n');
    expect(await readLocalMachineId(fs, dir)).toBe('dsh-home');
    expect(await readLocalMachineId(fs, path.join(dir, 'nope'))).toBeNull();
  });
});

describe('readRemoteMachineId', () => {
  it('runs ssh cat with fixed argv and trims output', async () => {
    const run = vi.fn(async () => ({ stdout: Buffer.from('dsh-company\n'), stderr: Buffer.alloc(0), exitCode: 0 }));
    expect(await readRemoteMachineId({ run } as any, 'kai@remote', '/home/kai/.dsh')).toBe('dsh-company');
    expect(run).toHaveBeenCalledWith('ssh', ['kai@remote', 'cat', '/home/kai/.dsh/machine-id'], { timeoutMs: 8000 });
  });

  it('returns null on non-zero exit', async () => {
    const run = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('nope'), exitCode: 1 }));
    expect(await readRemoteMachineId({ run } as any, 'kai@remote', '/home/kai/.dsh')).toBeNull();
  });
});
