/**
 * Bidirectional orchestration — one push-then-pull operation built from the
 * existing per-direction preview/apply primitives.
 *
 * Each phase keeps the full safety contract (single-use preview, per-file
 * CAS, fail closed); this module adds no new mutation route. The pull
 * preview is minted only AFTER the push apply has landed, so it is exact.
 * No auto-retry: the operator re-runs after reading the journal (union
 * idempotence makes a re-run resume the unfinished phase).
 */
import type { SyncService, ApplyResult } from './sync-service.js';
import type { SyncScope, SyncPreview, SyncSummary, SyncFailure } from './sync-types.js';

export interface BidirectionalPreview {
  /** Combined id — the push preview's id; the pull phase mints its own. */
  previewId: string;
  expiresAt: string;
  /** Exact push plan. */
  push: SyncPreview;
  /** Pull plan projected BEFORE the push lands; recomputed exact at apply time. */
  pullProjected: SyncPreview;
}

export interface BidirectionalResult {
  ok: boolean;
  push: ApplyResult;
  /** Null when the push failed — pull never runs. */
  pull: ApplyResult | null;
  /** Final pull dry-run summary; all-skip means converged. Null when pull never ran. */
  verification: SyncSummary | null;
  committed: string[];
  failures: SyncFailure[];
}

export async function runBidirectionalPreview(
  svc: SyncService,
  opts: { scope: SyncScope },
): Promise<BidirectionalPreview> {
  const push = await svc.preview({ direction: 'push', scope: opts.scope });
  const pullProjected = await svc.preview({ direction: 'pull', scope: opts.scope });
  return { previewId: push.previewId, expiresAt: push.expiresAt, push, pullProjected };
}

export async function runBidirectionalApply(
  svc: SyncService,
  opts: { previewId: string; confirm: true; scope: SyncScope },
): Promise<BidirectionalResult> {
  if ((opts as { confirm?: unknown }).confirm !== true) {
    throw Object.assign(new Error('bidirectional apply requires confirm:true'), { phase: 'validate', code: 'CONFIRM_REQUIRED' });
  }
  const push = await svc.apply({ previewId: opts.previewId, direction: 'push', confirm: true, scope: opts.scope });
  if (!push.ok) {
    return { ok: false, push, pull: null, verification: null, committed: [...push.committed], failures: [...push.failures] };
  }
  const pullPreview = await svc.preview({ direction: 'pull', scope: opts.scope });
  const pull = await svc.apply({ previewId: pullPreview.previewId, direction: 'pull', confirm: true, scope: opts.scope });
  const verify = await svc.preview({ direction: 'pull', scope: opts.scope });
  return {
    ok: pull.ok,
    push,
    pull,
    verification: verify.summary,
    committed: [...push.committed, ...pull.committed],
    failures: [...push.failures, ...pull.failures],
  };
}
