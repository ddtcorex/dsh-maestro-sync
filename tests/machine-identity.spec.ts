/**
 * Machine ids are DATA, not a fixed pair of names: each side writes its own id
 * to `$DSH_HOME/machine-id`, so the CLI must accept whatever those files
 * contain. The previous implementation hard-coded the operator's own two
 * machine names into the help text, the `--from/--to` validator and the peer
 * lookup — which both limited users to those names and leaked private
 * hostnames into a public repo (the Release workflow's leak guard rejects them,
 * so the package could not be published at all).
 */
import { describe, it, expect, vi } from 'vitest';
import { runCli } from '../src/host/cli.js';
import { isMachineId, peerMachineId } from '../src/host/machine-id.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out: (s: string) => out.push(s), err: (s: string) => err.push(s), stdout: () => out.join(''), stderr: () => err.join('') };
}

const fakeService = () => ({ preview: vi.fn(async () => ({})), apply: vi.fn(async () => ({})) }) as any;

function identity(localId: string | null, remoteId: string | null) {
  return {
    readLocal: vi.fn(async (_dshHome: string) => localId),
    readRemote: vi.fn(async (_host: string, _remoteDsh: string) => remoteId),
  };
}

describe('machine ids are data', () => {
  it('accepts any stable identifier and rejects junk', () => {
    expect(isMachineId('alpha-1')).toBe(true);
    expect(isMachineId('work.laptop_2')).toBe(true);
    expect(isMachineId('A1')).toBe(true);
    expect(isMachineId('')).toBe(false);
    expect(isMachineId('-leading-dash')).toBe(false);
    expect(isMachineId('has space')).toBe(false);
    expect(isMachineId('path/slash')).toBe(false);
  });

  it('resolves the peer from the two known ids, not from a name table', () => {
    expect(peerMachineId('alpha-1', 'alpha-1', 'beta-2')).toBe('beta-2');
    expect(peerMachineId('beta-2', 'alpha-1', 'beta-2')).toBe('alpha-1');
    // Unknown on either side: no guess.
    expect(peerMachineId('gamma-3', 'alpha-1', 'beta-2')).toBeNull();
    expect(peerMachineId('alpha-1', 'alpha-1', null)).toBeNull();
    expect(peerMachineId('alpha-1', null, null)).toBeNull();
  });

  it('accepts two arbitrary ids that match the two machine-id files', async () => {
    const c = capture();
    const code = await runCli(['check-machines', '--from', 'alpha-1', '--to', 'beta-2'], {
      stdout: c.out, stderr: c.err, makeService: fakeService, identity: identity('alpha-1', 'beta-2'),
    });
    expect(code).toBe(0);
    expect(JSON.parse(c.stdout().trim())).toMatchObject({ ok: true, localId: 'alpha-1', remoteId: 'beta-2', from: 'alpha-1', to: 'beta-2' });
  });

  it('infers the destination from the identities when --to is omitted', async () => {
    const c = capture();
    const code = await runCli(['check-machines', '--from', 'alpha-1'], {
      stdout: c.out, stderr: c.err, makeService: fakeService, identity: identity('alpha-1', 'beta-2'),
    });
    expect(code).toBe(0);
    expect(JSON.parse(c.stdout().trim())).toMatchObject({ ok: true, from: 'alpha-1', to: 'beta-2' });
  });

  it('infers the source from the local machine-id when --from is omitted', async () => {
    const c = capture();
    const code = await runCli(['check-machines'], {
      stdout: c.out, stderr: c.err, makeService: fakeService, identity: identity('alpha-1', 'beta-2'),
    });
    expect(code).toBe(0);
    expect(JSON.parse(c.stdout().trim())).toMatchObject({ ok: true, from: 'alpha-1', to: 'beta-2' });
  });

  it('rejects a malformed id instead of silently accepting it', async () => {
    const c = capture();
    const code = await runCli(['check-machines', '--from', 'not an id!'], {
      stdout: c.out, stderr: c.err, makeService: fakeService, identity: identity('alpha-1', 'beta-2'),
    });
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/machine id/i);
  });

  it('still refuses a bidirectional run started on the wrong side', async () => {
    const c = capture();
    const code = await runCli(['--bidirectional', '--from', 'beta-2', '--to', 'alpha-1', '--dry-run'], {
      stdout: c.out, stderr: c.err, makeService: fakeService, identity: identity('alpha-1', 'beta-2'),
    });
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/wrong-machine/);
  });

  it('fails closed when the peer cannot be derived', async () => {
    const c = capture();
    const code = await runCli(['check-machines', '--from', 'alpha-1'], {
      stdout: c.out, stderr: c.err, makeService: fakeService, identity: identity('alpha-1', null),
    });
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/--to/);
  });
});
