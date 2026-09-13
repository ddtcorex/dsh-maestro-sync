/**
 * CLI contract (Task 6):
 * - node lib/cli.js --pull|--push [--dry-run]  -> preview only, plan as final JSON on stdout
 * - node lib/cli.js --pull|--push --apply --preview-id ID --confirm  -> the only mutation form
 * - no omitted boolean can apply a sync: --apply without both --preview-id and --confirm exits 1
 * - --strategy=override requires a separate --ack-override acknowledgement
 */
import { describe, it, expect, vi } from 'vitest';
import { runCli } from '../src/host/cli.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

const fakePreview = () => ({
  previewId: 'p'.repeat(32),
  revision: 'rev1',
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  actions: [{ path: 'dsh-maestro-memory/daily/2026-08-29.md', action: 'merge', target: 'local', added: 1, reason: 'content differs' }],
  summary: { copied: 0, merged: 1, skipped: 0, conflicts: 0, added: 1 },
  connection: { ok: true, host: 'sync-host' },
  remoteHost: 'sync-host',
});

function makeService(applyResult?: any) {
  const apply = vi.fn(async (req: any) => applyResult ?? { ok: true, revision: 'rev1', summary: fakePreview().summary, committed: ['dsh-maestro-memory/daily/2026-08-29.md'], failures: [] });
  const preview = vi.fn(async () => fakePreview());
  return {
    factory: async () => ({ preview, apply }) as any,
    preview,
    apply,
  };
}

/** Hermetic machine ids for the CLI identity gate (never touches real HOME/ssh). */
function makeIdentity(localId: string | null = 'machine-a', remoteId: string | null = 'machine-b') {
  return {
    readLocal: vi.fn(async (_dshHome: string) => localId),
    readRemote: vi.fn(async (_host: string, _remoteDsh: string) => remoteId),
  };
}

describe('cli', () => {
  it('--pull with no apply flags is a preview: final JSON on stdout with previewId', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--dry-run', '--from', 'machine-b', '--to', 'machine-a'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(0);
    expect(m.preview).toHaveBeenCalledWith({ direction: 'pull' });
    expect(m.apply).not.toHaveBeenCalled();
    const json = JSON.parse(c.stdout().trim().split('\n').pop()!);
    expect(json.ok).toBe(true);
    expect(json.previewId).toBe('p'.repeat(32));
    expect(json.summary.merged).toBe(1);
  });

  it('--apply without --preview-id or --confirm exits non-zero and never previews/applies', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--apply'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(1);
    expect(c.stderr()).toContain('--preview-id');
    expect(m.apply).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
  });

  it('--apply requires --confirm as well as --preview-id', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--apply', '--preview-id', 'p'.repeat(32)], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(1);
    expect(c.stderr()).toContain('--confirm');
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('--apply --preview-id ID --confirm applies and prints the structured result', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--apply', '--preview-id', 'p'.repeat(32), '--confirm', '--from', 'machine-b', '--to', 'machine-a'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(0);
    expect(m.apply).toHaveBeenCalledWith({ previewId: 'p'.repeat(32), direction: 'pull', confirm: true });
    const json = JSON.parse(c.stdout().trim().split('\n').pop()!);
    expect(json.ok).toBe(true);
    expect(json.committed).toContain('dsh-maestro-memory/daily/2026-08-29.md');
  });

  it('an apply partial failure exits non-zero and prints ok:false with the journal', async () => {
    const c = capture();
    const m = makeService({ ok: false, revision: 'rev1', summary: fakePreview().summary, committed: [], failures: [{ phase: 'publish', code: 'COMMIT_FAILED', detail: 'boom', path: 'dsh-maestro-memory/daily/2026-08-29.md' }] });
    const code = await runCli(['--push', '--apply', '--preview-id', 'p'.repeat(32), '--confirm'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(1);
    const json = JSON.parse(c.stdout().trim().split('\n').pop()!);
    expect(json.ok).toBe(false);
    expect(json.failures.length).toBe(1);
  });

  it('--strategy=override requires a separate --ack-override acknowledgement', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--dry-run', '--strategy', 'override', '--from', 'machine-b', '--to', 'machine-a'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/ack-override/i);
    expect(m.preview).not.toHaveBeenCalled();
    // with the ack flag it proceeds
    const c2 = capture();
    const m2 = makeService();
    const code2 = await runCli(['--pull', '--dry-run', '--strategy', 'override', '--ack-override', '--from', 'machine-b', '--to', 'machine-a'], { stdout: c2.out, stderr: c2.err, makeService: m2.factory, identity: makeIdentity() });
    expect(code2).toBe(0);
  });

  it('--bidirectional is mutually exclusive with --pull/--push', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--bidirectional', '--pull'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/only one/i);
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('--bidirectional preview prints exact push plus projected pull plans', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--bidirectional', '--dry-run'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(0);
    expect(m.preview).toHaveBeenCalledWith({ direction: 'push', scope: 'memory' });
    expect(m.preview).toHaveBeenCalledWith({ direction: 'pull', scope: 'memory' });
    expect(m.apply).not.toHaveBeenCalled();
    const json = JSON.parse(c.stdout().trim().split('\n').pop()!);
    expect(json.ok).toBe(true);
    expect(json.push).toBeTruthy();
    expect(json.pullProjected).toBeTruthy();
  });

  it('--include-sessions widens the bidirectional scope to all', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--bidirectional', '--dry-run', '--include-sessions'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(0);
    expect(m.preview).toHaveBeenCalledWith({ direction: 'push', scope: 'all' });
  });

  it('--bidirectional --apply runs push then pull and prints the verification', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--bidirectional', '--apply', '--preview-id', 'p'.repeat(32), '--confirm'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(0);
    expect(m.apply).toHaveBeenCalledWith({ previewId: 'p'.repeat(32), direction: 'push', confirm: true, scope: 'memory' });
    const json = JSON.parse(c.stdout().trim().split('\n').pop()!);
    expect(json.ok).toBe(true);
    expect(json.verification).toBeTruthy();
  });

  it('--bidirectional rejects the destructive override strategy', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--bidirectional', '--strategy', 'override', '--ack-override'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/merge/i);
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('check-machines reports ids and fails closed on mismatch', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['check-machines', '--from', 'machine-a', '--to', 'machine-b'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(0);
    const json = JSON.parse(c.stdout().trim().split('\n').pop()!);
    expect(json).toMatchObject({ ok: true, localId: 'machine-a', remoteId: 'machine-b' });
  });

  it('check-machines exits 1 on wrong-machine without touching the service', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['check-machines', '--pull', '--from', 'machine-a', '--to', 'machine-b'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/wrong-machine/i);
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('--bidirectional with --from/--to mismatch exits non-zero before any preview', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--bidirectional', '--from', 'machine-a', '--to', 'machine-a', '--dry-run'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/wrong-machine/i);
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('--pull with matching --from/--to passes the identity gate', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--dry-run', '--from', 'machine-b', '--to', 'machine-a'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(code).toBe(0);
    expect(m.preview).toHaveBeenCalled();
  });

  it('tunnel-restore requires --confirm and --profile for the remote side', async () => {
    const c = capture();
    const m = makeService();
    const noConfirm = await runCli(['tunnel-restore', '--side', 'local'], { stdout: c.out, stderr: c.err, makeService: m.factory, identity: makeIdentity() });
    expect(noConfirm).toBe(1);
    expect(c.stderr()).toMatch(/--confirm/);
    const c2 = capture();
    const noProfile = await runCli(['tunnel-restore', '--side', 'remote', '--confirm'], { stdout: c2.out, stderr: c2.err, makeService: m.factory, identity: makeIdentity() });
    expect(noProfile).toBe(1);
    expect(c2.stderr()).toMatch(/--profile/);
  });
});