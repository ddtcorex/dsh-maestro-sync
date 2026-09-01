/**
 * Remote commit agent — the fixed CAS publisher that runs on the remote host.
 * The helper is a POSIX sh script executed for real (bash), so its backup/CAS/
 * rename semantics are tested, not mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sha256 } from './helpers/fake-transport.js';
import { remoteAgentSource, verifyRemoteAgentSource } from '../src/host/remote-agent.js';
import { SshRsyncTransport } from '../src/host/transport.js';

interface RemoteFixture {
  root: string;
  bin: string;
  cleanup: () => void;
}

function makeRemote(): RemoteFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-'));
  const bin = path.join(root, '.maestro-sync', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'maestro-sync-commit'), remoteAgentSource(), { mode: 0o700 });
  return {
    root,
    bin,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

function runCommit(remote: RemoteFixture, operationId: string, manifest: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(path.join(remote.bin, 'maestro-sync-commit'), [operationId], {
    input: manifest,
    encoding: 'utf-8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function stage(remote: RemoteFixture, operationId: string, rel: string, content: Buffer): void {
  const p = path.join(remote.root, '.maestro-sync', 'stage', operationId, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const MEM = 'memories/daily/2026-08-29.md';

beforeEach(() => {});

describe('remote-agent', () => {
  it('ships a POSIX sh helper that parses its own remote root and validates itself', () => {
    const src = remoteAgentSource();
    expect(src).toContain('maestro-sync-commit');
    expect(src).toContain('.maestro-sync/stage');
    // POSIX sh, no bashisms
    expect(src).not.toContain('[[ ');
    expect(src).not.toContain('function ');
    expect(() => verifyRemoteAgentSource(src)).not.toThrow();
  });

  it('commits a merged file when the target hash matches (backup + atomic rename)', async () => {
    const remote = makeRemote();
    try {
      const original = Buffer.from('a\n§\nremote1\n');
      const merged = Buffer.from('a\n§\nremote1\n§\nlocal1\n');
      const target = path.join(remote.root, MEM);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, original);
      stage(remote, 'op1', MEM, merged);

      const manifest = JSON.stringify({ path: MEM, expected: sha256(original) }) + '\n';
      const res = runCommit(remote, 'op1', manifest);
      expect(res.status).toBe(0);
      expect(fs.readFileSync(target).equals(merged)).toBe(true);
      // one timestamped backup exists beside the target
      const baks = fs.readdirSync(path.dirname(target)).filter((n) => n.endsWith('.bak.') || n.includes(MEM.split('/').pop()! + '.bak.'));
      expect(baks.length).toBe(1);
    } finally {
      remote.cleanup();
    }
  });

  it('reports CONCURRENT_MODIFICATION and leaves the target byte-identical on hash mismatch', async () => {
    const remote = makeRemote();
    try {
      const original = Buffer.from('a\n§\nremote1\n');
      const target = path.join(remote.root, MEM);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, original);
      // another machine overwrote the target after staging
      const newer = Buffer.from('a\n§\nremote2\n');
      fs.writeFileSync(target, newer);
      stage(remote, 'op1', MEM, Buffer.from('a\n§\nremote1\n§\nlocal1\n'));

      const manifest = JSON.stringify({ path: MEM, expected: sha256(original) }) + '\n';
      const res = runCommit(remote, 'op1', manifest);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('CONCURRENT_MODIFICATION');
      expect(fs.readFileSync(target).equals(newer)).toBe(true);
      expect(fs.readdirSync(path.dirname(target)).filter((n) => n.includes('.bak.')).length).toBe(0);
    } finally {
      remote.cleanup();
    }
  });

  it('publishes a copy when expected is absent and the target does not exist', async () => {
    const remote = makeRemote();
    try {
      const content = Buffer.from('new remote-only file\n');
      stage(remote, 'op1', 'memories/projects/new.md', content);
      const manifest = JSON.stringify({ path: 'memories/projects/new.md', expected: 'absent' }) + '\n';
      const res = runCommit(remote, 'op1', manifest);
      expect(res.status).toBe(0);
      expect(fs.readFileSync(path.join(remote.root, 'memories/projects/new.md')).equals(content)).toBe(true);
    } finally {
      remote.cleanup();
    }
  });

  it('rejects publish when expected is absent but the target appeared concurrently', async () => {
    const remote = makeRemote();
    try {
      const target = path.join(remote.root, MEM);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'someone else created it\n');
      stage(remote, 'op1', MEM, Buffer.from('our copy\n'));
      const manifest = JSON.stringify({ path: MEM, expected: 'absent' }) + '\n';
      const res = runCommit(remote, 'op1', manifest);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('CONCURRENT_MODIFICATION');
      expect(fs.readFileSync(target, 'utf-8')).toBe('someone else created it\n');
    } finally {
      remote.cleanup();
    }
  });

  it('transport.commit invokes the fixed helper path under the validated root', async () => {
    const run = vi.fn(async (file: string, args: readonly string[], opts?: any) => {
      expect(file).toBe('ssh');
      expect(args[0]).toBe('sync-host');
      expect(args[1]).toBe('/home/kai/.dsh/.maestro-sync/bin/maestro-sync-commit');
      expect(args[2]).toBe('op-abc');
      expect(Buffer.isBuffer(opts?.input)).toBe(true);
      return { stdout: Buffer.from('committed'), stderr: Buffer.alloc(0), exitCode: 0 };
    });
    const transport = new SshRsyncTransport({ run } as any);
    await transport.commit({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, 'op-abc', Buffer.from('[{}\n]'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('transport.ensureAgent installs the helper under .maestro-sync/bin via argv-only ssh', async () => {
    const calls: { file: string; args: string[]; input?: Buffer }[] = [];
    const run = vi.fn(async (file: string, args: readonly string[], opts?: any) => {
      calls.push({ file, args: [...args], input: opts?.input });
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    });
    const transport = new SshRsyncTransport({ run } as any);
    await transport.ensureAgent({ host: 'sync-host', dshRoot: '/home/kai/.dsh' });
    const sshCalls = calls.filter((c) => c.file === 'ssh');
    // mkdir -p, cat > helper, chmod
    expect(sshCalls.length).toBeGreaterThanOrEqual(2);
    const catCall = sshCalls.find((c) => c.args.join(' ').includes('cat >'));
    expect(catCall).toBeDefined();
    expect(catCall!.args.join(' ')).toContain('/home/kai/.dsh/.maestro-sync/bin/maestro-sync-commit');
    expect(Buffer.isBuffer(catCall!.input)).toBe(true);
    expect(catCall!.input!.toString('utf-8')).toContain('maestro-sync-commit');
  });
});