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

export interface FileSnapshot {
  path: string;
  sha256: string;
  size: number;
  kind: 'memory' | 'jsonl' | 'session';
}

export interface PlannedAction {
  path: string;
  action: 'copy' | 'merge' | 'skip' | 'conflict';
  target: 'local' | 'remote';
  added: number;
  reason: string;
  expectedTargetSha256?: string;
}

export interface SyncPlan {
  revision: string;
  actions: PlannedAction[];
  summary: SyncSummary;
}

export interface SyncPreview extends SyncPlan {
  previewId: string;
  expiresAt: string;
}

export interface PreviewRequest {
  direction: SyncDirection;
}

export interface ApplyRequest {
  previewId: string;
  direction: SyncDirection;
  confirm: true;
}
