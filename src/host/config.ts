import { load } from '@ddtcorex/dsh-maestro-config-lib';

export interface SyncConfig {
  remoteHost: string;
  remoteDshPath: string;
  strategy: string;
}

/**
 * Load sync config via @ddtcorex/dsh-maestro-config-lib load() -> domains.sync
 * Defaults: remoteHost = process.env.REMOTE_HOST || process.env.REMOTE || 'dsh-remote'
 *           remoteDshPath = '~/.dsh'
 *           strategy = 'merge'
 */
export async function loadSyncConfig(): Promise<SyncConfig> {
  const doc = await load();
  const sync = (doc.domains?.sync as Record<string, unknown> | undefined) ?? {};
  const remoteHost =
    (sync.remoteHost as string | undefined) ||
    process.env.REMOTE_HOST ||
    process.env.REMOTE ||
    'dsh-remote';
  const remoteDshPath = (sync.remoteDshPath as string | undefined) || '~/.dsh';
  const strategy = (sync.strategy as string | undefined) || 'merge';
  return { remoteHost, remoteDshPath, strategy };
}
