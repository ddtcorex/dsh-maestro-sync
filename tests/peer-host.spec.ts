/**
 * The peer SSH target is a per-machine fact: the two machines point at each
 * other, so a `remoteHost` saved on one of them names the wrong machine on the
 * other once the shared settings store travels. These tests pin the
 * machine-local peer file (`peer.json`) that owns this machine's own answer and
 * outranks the shared store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetForTests } from '@ddtcorex/dsh-maestro-config-lib';
import { clearPeerHost, peerHostPath, readPeerHost, writePeerHost } from '../src/host/peer-host.js';
import { loadSyncConfig, resolveRemoteHost } from '../src/host/config.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-peer-'));
  resetForTests();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.REMOTE_HOST;
  delete process.env.REMOTE;
});

/** Write a shared settings store holding `domains.sync.remoteHost`. */
function seedSharedStore(remoteHost: string): void {
  const dir = path.join(home, 'dsh-maestro-config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, domains: { sync: { remoteHost } } }));
}

describe('machine-local peer host', () => {
  it('round-trips a host and keeps the file private', () => {
    expect(writePeerHost(home, 'kai@ssh-peer.example')).toBe('kai@ssh-peer.example');
    expect(readPeerHost(home)).toBe('kai@ssh-peer.example');
    expect(fs.statSync(peerHostPath(home)).mode & 0o777).toBe(0o600);
  });

  it('reports null for a missing, malformed or invalid file', () => {
    expect(readPeerHost(home)).toBeNull();
    fs.mkdirSync(path.dirname(peerHostPath(home)), { recursive: true });
    fs.writeFileSync(peerHostPath(home), 'not json');
    expect(readPeerHost(home)).toBeNull();
    fs.writeFileSync(peerHostPath(home), JSON.stringify({ remoteHost: 'bad host; rm -rf /' }));
    expect(readPeerHost(home)).toBeNull();
    fs.writeFileSync(peerHostPath(home), JSON.stringify({ remoteHost: '' }));
    expect(readPeerHost(home)).toBeNull();
  });

  it('refuses an invalid host and writes nothing', () => {
    expect(() => writePeerHost(home, 'host=value')).toThrow(/invalid host/);
    expect(fs.existsSync(peerHostPath(home))).toBe(false);
  });

  it('clears the file', () => {
    writePeerHost(home, 'kai@ssh-peer.example');
    expect(clearPeerHost(home)).toBe(true);
    expect(readPeerHost(home)).toBeNull();
    expect(clearPeerHost(home)).toBe(false);
  });
});

describe('resolveRemoteHost precedence', () => {
  it('ranks machine-local above the shared store above env above the default', () => {
    const sources = { env: 'kai@env', stored: 'kai@stored', machineLocal: 'kai@machine' };
    expect(resolveRemoteHost(sources)).toBe('kai@machine');
    expect(resolveRemoteHost({ ...sources, machineLocal: null })).toBe('kai@stored');
    expect(resolveRemoteHost({ env: 'kai@env', stored: undefined, machineLocal: null })).toBe('kai@env');
    expect(resolveRemoteHost({})).toBe('kai@ssh.ddtcorex.com');
  });

  it('ignores blank candidates instead of returning them', () => {
    expect(resolveRemoteHost({ env: '   ', stored: '', machineLocal: null })).toBe('kai@ssh.ddtcorex.com');
  });
});

describe('loadSyncConfig peer resolution', () => {
  it('lets this machine override a shared store that names another machine', async () => {
    // The store was saved on the peer machine and copied here, so on this
    // machine it names the wrong address.
    seedSharedStore('kai@ssh-inherited.example');
    writePeerHost(home, 'kai@ssh-mine.example');
    await expect(loadSyncConfig({ dshHome: home })).resolves.toMatchObject({ remoteHost: 'kai@ssh-mine.example' });
  });

  it('falls back to the shared store when this machine has no peer file', async () => {
    seedSharedStore('kai@ssh-stored.example');
    await expect(loadSyncConfig({ dshHome: home })).resolves.toMatchObject({ remoteHost: 'kai@ssh-stored.example' });
  });
});
