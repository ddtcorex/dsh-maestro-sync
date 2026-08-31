export type SyncDirection = 'pull' | 'push';

export type SyncPhase = 'validate' | 'snapshot' | 'stage' | 'plan' | 'publish' | 'cleanup';

export interface RemoteTarget {
  host: string;
  dshRoot: string;
}

export interface SyncRequest {
  direction: SyncDirection;
  dryRun: boolean;
  localRoot: string;
  remote: RemoteTarget;
}

export interface SyncFailure {
  phase: SyncPhase;
  code: string;
  detail: string;
  path?: string;
}

export interface SyncSummary {
  copied: number;
  merged: number;
  skipped: number;
  conflicts: number;
  added: number;
}
