import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkMachines, readLocalMachineId, readRemoteMachineId } from '../src/host/machine-id.js';

describe('checkMachines', () => {
  it('pull requires from === remoteId', () => {
    const bad = checkMachines({ mode: 'pull', from: 'machine-a', to: 'machine-b', localId: 'machine-a', remoteId: 'machine-b' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/\[wrong-machine\]/);
    const good = checkMachines({ mode: 'pull', from: 'machine-b', to: 'machine-a', localId: 'machine-a', remoteId: 'machine-b' });
    expect(good).toMatchObject({ ok: true, localId: 'machine-a', remoteId: 'machine-b' });
  });

  it('bidirectional requires from === local && to === remote', () => {
    expect(checkMachines({ mode: 'bidirectional', from: 'machine-a', to: 'machine-b', localId: 'machine-a', remoteId: 'machine-b' }).ok).toBe(true);
    expect(checkMachines({ mode: 'bidirectional', from: 'machine-b', to: 'machine-a', localId: 'machine-a', remoteId: 'machine-b' }).ok).toBe(false);
  });

  it('unknown ids are lenient, from === to always fails', () => {
    expect(checkMachines({ mode: 'pull', from: 'machine-a', to: 'machine-b', localId: null, remoteId: null }).ok).toBe(true);
    const same = checkMachines({ mode: 'push', from: 'machine-a', to: 'machine-a', localId: 'machine-a', remoteId: 'machine-b' });
    expect(same.ok).toBe(false);
  });
});

describe('readLocalMachineId', () => {
  it('reads and trims the machine-id file, null when missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-id-'));
    fs.writeFileSync(path.join(dir, 'machine-id'), 'machine-a\n');
    expect(await readLocalMachineId(fs, dir)).toBe('machine-a');
    expect(await readLocalMachineId(fs, path.join(dir, 'nope'))).toBeNull();
  });
});

describe('readRemoteMachineId', () => {
  it('runs ssh cat with fixed argv and trims output', async () => {
    const run = vi.fn(async () => ({ stdout: Buffer.from('machine-b\n'), stderr: Buffer.alloc(0), exitCode: 0 }));
    expect(await readRemoteMachineId({ run } as any, 'kai@remote', '/home/kai/.dsh')).toBe('machine-b');
    expect(run).toHaveBeenCalledWith('ssh', ['kai@remote', 'cat', '/home/kai/.dsh/machine-id'], { timeoutMs: 8000 });
  });

  it('returns null on non-zero exit', async () => {
    const run = vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('nope'), exitCode: 1 }));
    expect(await readRemoteMachineId({ run } as any, 'kai@remote', '/home/kai/.dsh')).toBeNull();
  });
});
