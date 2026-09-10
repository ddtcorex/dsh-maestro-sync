import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SyncTransport } from './transport.js';
import type { RemoteTarget } from './sync-types.js';

export type LocalRestoreResult = { ok: true; profile: string } | { ok: false; code: 'NO_PROFILE' | 'INVALID_PROFILE' };
export type RemoteRestoreResult =
  | { ok: true; profile: string; changed: boolean; sha256: string }
  | { ok: false; code: 'BAD_PROFILE' };

/** Profile names are single path segments; mirrors the remote-agent allowlist. */
export function isSafeProfileName(name: string): boolean {
  if (!name || name.startsWith('.') || name.includes('..') || name.includes('/')) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * The tunnel domain is a named-tunnel OBJECT (mode/hostname/...), never a
 * bare string. A string write clobbered the object shape on 2026-09-09 and
 * took the dsh-home tunnel down (HTTP 530) — so a non-object profile value
 * fails closed here before anything is written.
 */
export function isValidTunnelDomain(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  return typeof t.mode === 'string' && t.mode.length > 0 && typeof t.hostname === 'string' && t.hostname.length > 0;
}

/**
 * Local tunnel profile restore: re-patches the moved shared store
 * (<dsh>/dsh-maestro-config/settings.json via config-lib) domains.tunnel
 * from this machine's own profile dir. Never throws; profiles may not
 * exist on CI.
 */
export async function restoreLocalTunnel(opts?: { dshHome?: string; profileName?: string }): Promise<LocalRestoreResult> {
  try {
    const dshHome = opts?.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    const profilesRoot = path.join(dshHome, 'dsh-maestro-remote', 'tunnel-profiles');
    if (!fs.existsSync(profilesRoot)) return { ok: false, code: 'NO_PROFILE' };
    let profiles: string[] = [];
    try {
      profiles = fs.readdirSync(profilesRoot).filter((n) => {
        try {
          return fs.statSync(path.join(profilesRoot, n)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return { ok: false, code: 'NO_PROFILE' };
    }
    if (profiles.length === 0) return { ok: false, code: 'NO_PROFILE' };

    const envProfile = process.env.LOCAL_TUNNEL_PROFILE || process.env.TUNNEL_PROFILE;
    const wanted = opts?.profileName ?? (envProfile && profiles.includes(envProfile) ? envProfile : undefined);
    const profileName = wanted ?? profiles[0];
    if (!profileName) return { ok: false, code: 'NO_PROFILE' };

    const profileDir = path.join(profilesRoot, profileName);
    const tunnelSettingsPath = path.join(profileDir, 'settings-tunnel.json');
    const cloudflaredSrc = path.join(profileDir, 'cloudflared-config.yml');
    const cloudflaredDst = path.join(dshHome, 'dsh-maestro-remote', 'cloudflared-config.yml');
    const settingsPath = path.join(dshHome, 'dsh-maestro-config', 'settings.json');

    // Gate only on the profile source: the store file itself may be absent
    // (config-lib recreates it); a missing store must not skip the restore.
    if (!fs.existsSync(tunnelSettingsPath)) return { ok: false, code: 'NO_PROFILE' };

    try {
      if (fs.existsSync(cloudflaredSrc) && fs.existsSync(path.dirname(cloudflaredDst))) {
        fs.copyFileSync(cloudflaredSrc, cloudflaredDst);
        try {
          fs.chmodSync(cloudflaredDst, 0o600);
        } catch {}
      }
    } catch {}

    try {
      const tunnelJson = JSON.parse(fs.readFileSync(tunnelSettingsPath, 'utf-8'));
      const tunnelDomain = tunnelJson?.domains?.tunnel;
      if (!isValidTunnelDomain(tunnelDomain)) return { ok: false, code: 'INVALID_PROFILE' };
      try {
        const cfgLib: any = await import('@ddtcorex/dsh-maestro-config-lib');
        if (typeof cfgLib.set === 'function') {
          await cfgLib.set('tunnel', tunnelDomain);
          return { ok: true, profile: profileName };
        }
      } catch {}
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const doc = JSON.parse(raw);
      doc.domains = doc.domains || {};
      doc.domains.tunnel = tunnelDomain;
      const tmp = settingsPath + '.tmp.' + Math.random().toString(16).slice(2, 6);
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmp, settingsPath);
      try {
        fs.chmodSync(settingsPath, 0o600);
      } catch {}
      return { ok: true, profile: profileName };
    } catch {
      return { ok: false, code: 'NO_PROFILE' };
    }
  } catch {
    return { ok: false, code: 'NO_PROFILE' };
  }
}

/**
 * Remote tunnel restore via the fixed agent op: the profile is read on the
 * remote itself and only `domains.tunnel` is rewritten. No settings bytes
 * cross the wire. Transport errors propagate (fail closed, typed failure).
 */
export async function restoreRemoteTunnel(
  transport: Pick<SyncTransport, 'patchRemoteTunnel'>,
  target: RemoteTarget,
  profileName: string,
): Promise<RemoteRestoreResult> {
  if (!isSafeProfileName(profileName)) return { ok: false, code: 'BAD_PROFILE' };
  const out = await transport.patchRemoteTunnel(target, profileName);
  return { ok: true, profile: profileName, changed: out.changed, sha256: out.sha256 };
}
