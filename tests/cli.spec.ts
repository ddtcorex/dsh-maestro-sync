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
  actions: [{ path: 'memories/daily/2026-08-29.md', action: 'merge', target: 'local', added: 1, reason: 'content differs' }],
  summary: { copied: 0, merged: 1, skipped: 0, conflicts: 0, added: 1 },
  connection: { ok: true, host: 'sync-host' },
  remoteHost: 'sync-host',
});

function makeService(applyResult?: any) {
  const apply = vi.fn(async (req: any) => applyResult ?? { ok: true, revision: 'rev1', summary: fakePreview().summary, committed: ['memories/daily/2026-08-29.md'], failures: [] });
  const preview = vi.fn(async () => fakePreview());
  return {
    factory: async () => ({ preview, apply }) as any,
    preview,
    apply,
  };
}

describe('cli', () => {
  it('--pull with no apply flags is a preview: final JSON on stdout with previewId', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--dry-run'], { stdout: c.out, stderr: c.err, makeService: m.factory });
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
    const code = await runCli(['--pull', '--apply'], { stdout: c.out, stderr: c.err, makeService: m.factory });
    expect(code).toBe(1);
    expect(c.stderr()).toContain('--preview-id');
    expect(m.apply).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
  });

  it('--apply requires --confirm as well as --preview-id', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--apply', '--preview-id', 'p'.repeat(32)], { stdout: c.out, stderr: c.err, makeService: m.factory });
    expect(code).toBe(1);
    expect(c.stderr()).toContain('--confirm');
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('--apply --preview-id ID --confirm applies and prints the structured result', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--apply', '--preview-id', 'p'.repeat(32), '--confirm'], { stdout: c.out, stderr: c.err, makeService: m.factory });
    expect(code).toBe(0);
    expect(m.apply).toHaveBeenCalledWith({ previewId: 'p'.repeat(32), direction: 'pull', confirm: true });
    const json = JSON.parse(c.stdout().trim().split('\n').pop()!);
    expect(json.ok).toBe(true);
    expect(json.committed).toContain('memories/daily/2026-08-29.md');
  });

  it('an apply partial failure exits non-zero and prints ok:false with the journal', async () => {
    const c = capture();
    const m = makeService({ ok: false, revision: 'rev1', summary: fakePreview().summary, committed: [], failures: [{ phase: 'publish', code: 'COMMIT_FAILED', detail: 'boom', path: 'memories/daily/2026-08-29.md' }] });
    const code = await runCli(['--push', '--apply', '--preview-id', 'p'.repeat(32), '--confirm'], { stdout: c.out, stderr: c.err, makeService: m.factory });
    expect(code).toBe(1);
    const json = JSON.parse(c.stdout().trim().split('\n').pop()!);
    expect(json.ok).toBe(false);
    expect(json.failures.length).toBe(1);
  });

  it('--strategy=override requires a separate --ack-override acknowledgement', async () => {
    const c = capture();
    const m = makeService();
    const code = await runCli(['--pull', '--dry-run', '--strategy', 'override'], { stdout: c.out, stderr: c.err, makeService: m.factory });
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/ack-override/i);
    expect(m.preview).not.toHaveBeenCalled();
    // with the ack flag it proceeds
    const c2 = capture();
    const m2 = makeService();
    const code2 = await runCli(['--pull', '--dry-run', '--strategy', 'override', '--ack-override'], { stdout: c2.out, stderr: c2.err, makeService: m2.factory });
    expect(code2).toBe(0);
  });
});