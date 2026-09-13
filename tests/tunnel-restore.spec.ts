import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { restoreLocalTunnel, restoreRemoteTunnel } from '../src/host/tunnel-restore.js';

// The shared store moved to <dsh>/dsh-maestro-config/settings.json (config-lib,
// which honors DSH_HOME). The restore must target the moved path — never the
// retired maestro/settings.json (09-09 machine-a outage: identity stayed
// clobbered after a --pull, plugin fell back to quick mode and never
// auto-restored the named tunnel).
const STORE_REL = path.join('dsh-maestro-config', 'settings.json');
const LEGACY_REL = path.join('maestro', 'settings.json');

const tmpHomes: string[] = [];
let savedDshHome: string | undefined;
let savedProfile: string | undefined;

function useTempHome(): string {
  if (tmpHomes.length === 0) {
    savedDshHome = process.env.DSH_HOME;
    savedProfile = process.env.LOCAL_TUNNEL_PROFILE;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-restore-'));
  tmpHomes.push(home);
  process.env.DSH_HOME = home;
  delete process.env.LOCAL_TUNNEL_PROFILE;
  return home;
}

afterEach(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  if (savedProfile === undefined) delete process.env.LOCAL_TUNNEL_PROFILE;
  else process.env.LOCAL_TUNNEL_PROFILE = savedProfile;
  savedDshHome = undefined;
  savedProfile = undefined;
  while (tmpHomes.length > 0) fs.rmSync(tmpHomes.pop()!, { recursive: true, force: true });
});

function seedHome(tunnel: unknown = { mode: 'named', id: 'test-id', hostname: 'machine-a.example.com' }): string {
  const home = useTempHome();
  const prof = path.join(home, 'dsh-maestro-remote', 'tunnel-profiles', 'machine-a');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'settings-tunnel.json'), JSON.stringify({ domains: { tunnel } }));
  fs.mkdirSync(path.join(home, 'dsh-maestro-config'), { recursive: true });
  fs.writeFileSync(
    path.join(home, STORE_REL),
    JSON.stringify({ domains: { tunnel: { mode: 'named', hostname: 'stale' }, jobs: { x: 1 } } }),
  );
  return home;
}

describe('restoreLocalTunnel', () => {
  it('patches only domains.tunnel from the machine profile', async () => {
    const home = seedHome();
    const r = await restoreLocalTunnel({ dshHome: home, profileName: 'machine-a' });
    expect(r.ok).toBe(true);
    const doc = JSON.parse(fs.readFileSync(path.join(home, STORE_REL), 'utf-8'));
    expect(doc.domains.tunnel).toEqual({ mode: 'named', id: 'test-id', hostname: 'machine-a.example.com' });
    expect(doc.domains.jobs).toEqual({ x: 1 });
  });

  it('creates the moved store when it is absent and never the legacy path', async () => {
    const home = useTempHome();
    const prof = path.join(home, 'dsh-maestro-remote', 'tunnel-profiles', 'machine-a');
    fs.mkdirSync(prof, { recursive: true });
    const tunnel = { mode: 'named', id: 'a6a31b92', hostname: 'machine-a.ddtcorex.com' };
    fs.writeFileSync(path.join(prof, 'settings-tunnel.json'), JSON.stringify({ domains: { tunnel } }));
    expect(fs.existsSync(path.join(home, LEGACY_REL))).toBe(false);
    const r = await restoreLocalTunnel({ dshHome: home, profileName: 'machine-a' });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(home, STORE_REL))).toBe(true);
    const doc = JSON.parse(fs.readFileSync(path.join(home, STORE_REL), 'utf-8'));
    expect(doc.domains.tunnel).toEqual(tunnel);
    expect(fs.existsSync(path.join(home, LEGACY_REL))).toBe(false);
  });

  it('refuses a string tunnel value instead of clobbering the object shape', async () => {
    const home = seedHome('machine-a.ddtcorex.com');
    const before = fs.readFileSync(path.join(home, STORE_REL), 'utf-8');
    const r = await restoreLocalTunnel({ dshHome: home, profileName: 'machine-a' });
    expect(r).toEqual({ ok: false, code: 'INVALID_PROFILE' });
    expect(fs.readFileSync(path.join(home, STORE_REL), 'utf-8')).toBe(before);
  });

  it('returns NO_PROFILE when the profile dir is absent', async () => {
    const home = useTempHome();
    expect(await restoreLocalTunnel({ dshHome: home })).toMatchObject({ ok: false });
  });
});

describe('restoreRemoteTunnel', () => {
  it('delegates to the fixed agent op and reports changed + sha', async () => {
    const sha = 'b'.repeat(64);
    const patchRemoteTunnel = vi.fn(async () => ({ changed: true, sha256: sha }));
    const r = await restoreRemoteTunnel({ patchRemoteTunnel } as any, { host: 'sync-host', dshRoot: '/home/kai/.dsh' } as any, 'machine-b');
    expect(r).toEqual({ ok: true, profile: 'machine-b', changed: true, sha256: sha });
    expect(patchRemoteTunnel).toHaveBeenCalledWith({ host: 'sync-host', dshRoot: '/home/kai/.dsh' }, 'machine-b');
  });

  it('rejects unsafe profile names before touching the transport', async () => {
    const patchRemoteTunnel = vi.fn(async () => ({ changed: true, sha256: 'c'.repeat(64) }));
    const r = await restoreRemoteTunnel({ patchRemoteTunnel } as any, { host: 'sync-host', dshRoot: '/home/kai/.dsh' } as any, '../escape');
    expect(r.ok).toBe(false);
    expect(patchRemoteTunnel).not.toHaveBeenCalled();
  });
});
