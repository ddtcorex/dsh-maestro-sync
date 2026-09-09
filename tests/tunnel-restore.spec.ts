import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Force the fs fallback path: the config-lib store writes to the real home,
// not the seeded temp dir, so it must be unavailable in hermetic tests.
vi.mock('@ddtcorex/dsh-maestro-config-lib', () => ({
  load: async () => ({}),
  set: async () => { throw new Error('no store in test'); },
}));

import { restoreLocalTunnel, restoreRemoteTunnel } from '../src/host/tunnel-restore.js';

function seedHome(tunnel: unknown = { mode: 'named', id: 'test-id', hostname: 'dsh-home.example.com' }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-restore-'));
  const prof = path.join(home, 'dsh-maestro-remote', 'tunnel-profiles', 'dsh-home');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'settings-tunnel.json'), JSON.stringify({ domains: { tunnel } }));
  fs.mkdirSync(path.join(home, 'maestro'), { recursive: true });
  fs.writeFileSync(path.join(home, 'maestro', 'settings.json'), JSON.stringify({ domains: { tunnel: { mode: 'named', hostname: 'stale' }, jobs: { x: 1 } } }));
  return home;
}

describe('restoreLocalTunnel', () => {
  it('patches only domains.tunnel from the machine profile', async () => {
    const home = seedHome();
    const r = await restoreLocalTunnel({ dshHome: home, profileName: 'dsh-home' });
    expect(r.ok).toBe(true);
    const doc = JSON.parse(fs.readFileSync(path.join(home, 'maestro', 'settings.json'), 'utf-8'));
    expect(doc.domains.tunnel).toEqual({ mode: 'named', id: 'test-id', hostname: 'dsh-home.example.com' });
    expect(doc.domains.jobs).toEqual({ x: 1 });
  });

  it('refuses a string tunnel value instead of clobbering the object shape', async () => {
    const home = seedHome('dsh-home.ddtcorex.com');
    const before = fs.readFileSync(path.join(home, 'maestro', 'settings.json'), 'utf-8');
    const r = await restoreLocalTunnel({ dshHome: home, profileName: 'dsh-home' });
    expect(r).toEqual({ ok: false, code: 'INVALID_PROFILE' });
    expect(fs.readFileSync(path.join(home, 'maestro', 'settings.json'), 'utf-8')).toBe(before);
  });

  it('returns NO_PROFILE when the profile dir is absent', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-restore-empty-'));
    expect(await restoreLocalTunnel({ dshHome: home })).toMatchObject({ ok: false });
  });
});

describe('restoreRemoteTunnel', () => {
  it('delegates to the fixed agent op and reports changed + sha', async () => {
    const sha = 'b'.repeat(64);
    const patchRemoteTunnel = vi.fn(async () => ({ changed: true, sha256: sha }));
    const r = await restoreRemoteTunnel({ patchRemoteTunnel } as any, { host: 'sync-host', dshRoot: '/home/kai/.dsh' } as any, 'dsh-company');
    expect(r).toEqual({ ok: true, profile: 'dsh-company', changed: true, sha256: sha });
    expect(patchRemoteTunnel).toHaveBeenCalledWith({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, 'dsh-company');
  });

  it('rejects unsafe profile names before touching the transport', async () => {
    const patchRemoteTunnel = vi.fn(async () => ({ changed: true, sha256: 'c'.repeat(64) }));
    const r = await restoreRemoteTunnel({ patchRemoteTunnel } as any, { host: 'sync-host', dshRoot: '/home/kai/.dsh' } as any, '../escape');
    expect(r.ok).toBe(false);
    expect(patchRemoteTunnel).not.toHaveBeenCalled();
  });
});
