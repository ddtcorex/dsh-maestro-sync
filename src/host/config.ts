import { load } from '@ddtcorex/dsh-maestro-config-lib';
import { validateRemoteTarget } from './validation.js';
import type { RemoteTarget, SyncDirection, SyncRequest } from './sync-types.js';

export interface SyncConfig {
  remoteHost: string;
  remoteDshPath: string;
  strategy: string;
}

/**
 * Load sync config via @ddtcorex/dsh-maestro-config-lib load() -> domains.sync
 * Defaults: remoteHost = process.env.REMOTE_HOST || process.env.REMOTE || 'kai@ssh.ddtcorex.com'
 *           remoteDshPath = sync.remoteDshPath || REMOTE_DSH_PATH env || '~/.dsh' (unresolved placeholder)
 *           strategy = 'merge'
 *
 * NOTE: remoteDshPath may be '~/.dsh' as stored placeholder. It is NOT a validated
 * absolute path. Caller must validate via `validateRemoteTarget` / `buildSyncRequest`
 * before constructing a SyncRequest. The absolute remote home is resolved by the
 * transport preflight (ssh remoteHome), not by shell ~ expansion.
 */
export async function loadSyncConfig(): Promise<SyncConfig> {
  const doc = await load();
  const sync = (doc.domains?.sync as Record<string, unknown> | undefined) ?? {};
  const remoteHost =
    (sync.remoteHost as string | undefined) ||
    process.env.REMOTE_HOST ||
    process.env.REMOTE ||
    'kai@ssh.ddtcorex.com';
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
