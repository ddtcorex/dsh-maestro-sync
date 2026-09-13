import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateHost } from './validation.js';

/**
 * The peer SSH target as THIS machine sees it. `remoteHost` in the shared
 * settings store travels between the two machines (it is written by whichever
 * machine saved it and copied with the rest of the store), so a machine can
 * inherit the other machine's address — which resolves to itself there. This
 * file is machine-local and outranks the shared store, exactly like the tunnel
 * profile owns `domains.tunnel`.
 */
export const PEER_HOST_REL = 'dsh-maestro-sync/peer.json';

/** DSH home the host resolves when no explicit one is given. */
export function defaultDshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function peerHostPath(dshHome: string): string {
  return path.join(dshHome, PEER_HOST_REL);
}

/**
 * This machine's own peer target, or null when it was never set (callers then
 * fall back to the shared store). An unreadable or invalid file is null, never
 * a throw: the peer of a machine that has none is simply not known yet.
 */
export function readPeerHost(dshHome?: string): string | null {
  const home = dshHome ?? defaultDshHome();
  try {
    const parsed = JSON.parse(fs.readFileSync(peerHostPath(home), 'utf-8'));
    const host = (parsed as Record<string, unknown> | null)?.remoteHost;
    return typeof host === 'string' && host.length > 0 ? validateHost(host.trim()) : null;
  } catch {
    return null;
  }
}

/** Record this machine's peer target; returns the validated host. */
export function writePeerHost(dshHome: string, host: string): string {
  const valid = validateHost(host.trim());
  const file = peerHostPath(dshHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ remoteHost: valid, writtenAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  return valid;
}

/** Drop this machine's peer target; the shared store takes over again. */
export function clearPeerHost(dshHome: string): boolean {
  try {
    fs.unlinkSync(peerHostPath(dshHome));
    return true;
  } catch {
    return false;
  }
}
