import { load } from '@ddtcorex/dsh-maestro-config-lib';
import { validateRemoteTarget } from './validation.js';
import { readPeerHost } from './peer-host.js';
import type { RemoteTarget, SyncDirection, SyncRequest } from './sync-types.js';

export interface SyncConfig {
  remoteHost: string;
  remoteDshPath: string;
  strategy: string;
}

/** The built-in SSH target, reached only when nothing was ever configured. */
export const DEFAULT_REMOTE_HOST = 'kai@ssh.ddtcorex.com';

/**
 * Effective peer host from the four sources, highest first:
 *
 * 1. This machine's own `peer.json` — machine-local truth (see peer-host.ts).
 * 2. The shared settings store `domains.sync.remoteHost` — UI-editable, but it
 *    travels between machines, so on the mirrored machine it can name that
 *    machine instead of its peer.
 * 3. `REMOTE_HOST` / `REMOTE` env.
 * 4. {@link DEFAULT_REMOTE_HOST}.
 *
 * The machine-local file deliberately outranks the shared store: a machine that
 * inherited the other machine's address must be able to state its own peer
 * without editing a file both machines share. Env stays below the store because
 * callers that need to force a target pass it explicitly (`--remote`), which
 * wins over this whole list.
 */
export function resolveRemoteHost(sources: {
  env?: string;
  machineLocal?: string | null;
  stored?: string;
  fallback?: string;
}): string {
  const first = [sources.machineLocal ?? undefined, sources.stored, sources.env].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
  );
  return first ?? sources.fallback ?? DEFAULT_REMOTE_HOST;
}

/**
 * Load sync config via @ddtcorex/dsh-maestro-config-lib load() -> domains.sync
 * Peer host precedence: see {@link resolveRemoteHost}.
 *           remoteDshPath = sync.remoteDshPath || REMOTE_DSH_PATH env || '~/.dsh' (unresolved placeholder)
 *           strategy = 'merge'
 *
 * NOTE: remoteDshPath may be '~/.dsh' as stored placeholder. It is NOT a validated
 * absolute path. Caller must validate via `validateRemoteTarget` / `buildSyncRequest`
 * before constructing a SyncRequest. The absolute remote home is resolved by the
 * transport preflight (ssh remoteHome), not by shell ~ expansion.
 *
 * @param opts.dshHome DSH home holding this machine's peer file; the caller's
 *   own resolved home wins over the ambient default.
 */
export async function loadSyncConfig(opts: { dshHome?: string } = {}): Promise<SyncConfig> {
  const doc = await load({ dshHome: opts.dshHome });
  const sync = (doc.domains?.sync as Record<string, unknown> | undefined) ?? {};
  const remoteHost = resolveRemoteHost({
    env: process.env.REMOTE_HOST || process.env.REMOTE,
    machineLocal: readPeerHost(opts.dshHome),
    stored: sync.remoteHost as string | undefined,
  });
  const remoteDshPath = (sync.remoteDshPath as string | undefined) || process.env.REMOTE_DSH_PATH || '~/.dsh';
  const strategy = (sync.strategy as string | undefined) || 'merge';
  return { remoteHost, remoteDshPath, strategy };
}

/**
 * Validate and convert a SyncConfig's remote fields into a RemoteTarget.
 * Throws if host or dshRoot is not validated absolute.
 */
export function configToRemoteTarget(config: SyncConfig): RemoteTarget {
  return validateRemoteTarget({ host: config.remoteHost, dshRoot: config.remoteDshPath });
}

/**
 * Build a validated SyncRequest. Remote is validated via validateRemoteTarget;
 * localRoot is expected to be an absolute local path (lightly validated as absolute).
 * Throws on invalid host/path.
 */
export function buildSyncRequest(params: {
  direction: SyncDirection;
  dryRun: boolean;
  localRoot: string;
  remoteHost: string;
  remoteDshPath: string;
}): SyncRequest {
  const remote = validateRemoteTarget({ host: params.remoteHost, dshRoot: params.remoteDshPath });
  // localRoot should be absolute; reuse ABSOLUTE notion but allow local home paths
  if (!params.localRoot || typeof params.localRoot !== 'string' || !params.localRoot.startsWith('/')) {
    throw new Error(`invalid localRoot: must be absolute path: ${JSON.stringify(params.localRoot)}`);
  }
  if (params.localRoot.includes('\u0000') || params.localRoot.includes('\n')) {
    throw new Error('invalid localRoot: contains control characters');
  }
  return {
    direction: params.direction,
    dryRun: params.dryRun,
    localRoot: params.localRoot,
    remote,
  };
}

/**
 * Helper: resolve effective remote target from config + env + cli overrides,
 * but do NOT auto-expand '~'. Caller must handle unresolved '~/.dsh' via
 * transport preflight (remoteHome) before building SyncRequest.
 */
export function resolveRemoteTargetFromConfig(
  config: SyncConfig,
  overrides?: { remoteHost?: string; remoteDshPath?: string },
): { host: string; dshRoot: string; needsPreflight: boolean } {
  const host = overrides?.remoteHost ?? config.remoteHost;
  const dshRoot = overrides?.remoteDshPath ?? config.remoteDshPath;
  const needsPreflight = dshRoot === '~/.dsh' || dshRoot.startsWith('~/');
  return { host, dshRoot, needsPreflight };
}
