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
  /** present when sessions were counted by checksum instead of staged */
  sessionCounts?: SessionCounts;
}

/** Session-only preview counts (computed from path+checksum, no content staged). */
export interface SessionCounts {
  /** files that only exist on the incoming side (will be copied) */
  added: number;
  /** files present on both sides with different checksums (will be merged) */
  updated: number;
  /** files that exist locally but the remote has dropped (pull keeps them; counted only) */
  deleted: number;
  /** files byte-identical on both sides (skipped) */
  identical: number;
}

export interface SyncPreview extends SyncPlan {
  previewId: string;
  expiresAt: string;
  /** present when sessions were counted by checksum instead of staged */
  sessionCounts?: SessionCounts;
}

/** Per-file progress tick for async preview. */
export interface SyncProgress {
  phase: 'listing' | 'hashing' | 'staging' | 'planning';
  current: number;
  total: number;
  file?: string;
}

/** Job state exposed by RPC while a preview runs in the background. */
export interface PreviewJobState {
  status: 'running' | 'done' | 'error';
  progress: SyncProgress;
  preview?: SyncPreview;
  error?: string;
}

export interface PreviewRequest {
  direction: SyncDirection;
}

export interface ApplyRequest {
  previewId: string;
  direction: SyncDirection;
  confirm: true;
}
