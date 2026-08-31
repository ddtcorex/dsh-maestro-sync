import { createHash, randomBytes } from 'node:crypto';
import type { FileSnapshot, PlannedAction, SyncPlan, SyncPreview, SyncSummary, SyncDirection } from './sync-types.js';
import { mergeDelimited } from './merge.js';

export interface PreviewStore {
  get(id: string): SyncPreview | undefined;
  set(preview: SyncPreview): void;
  delete(id: string): void;
}

const previews = new Map<string, SyncPreview>();

export function storePreview(preview: SyncPreview): void {
  previews.set(preview.previewId, preview);
  setTimeout(() => previews.delete(preview.previewId), 60_000);
}

export function getPreview(id: string): SyncPreview | undefined {
  const p = previews.get(id);
  if (!p) return undefined;
  if (new Date(p.expiresAt).getTime() < Date.now()) {
    previews.delete(id);
    return undefined;
  }
  return p;
}

export function clearPreviews(): void {
  previews.clear();
}

function revisionFrom(snapshots: FileSnapshot[], direction: SyncDirection): string {
  const h = createHash('sha256');
  h.update(direction);
  for (const s of snapshots.sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(s.path + ':' + s.sha256);
  }
  return h.digest('hex').slice(0, 12);
}

export async function buildPlan(
  localSnapshots: FileSnapshot[],
  remoteSnapshots: FileSnapshot[],
  direction: SyncDirection,
  localContents: Map<string, Buffer>,
  remoteContents: Map<string, Buffer>,
): Promise<SyncPlan> {
  const localMap = new Map(localSnapshots.map((s) => [s.path, s]));
  const remoteMap = new Map(remoteSnapshots.map((s) => [s.path, s]));
  const allPaths = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const actions: PlannedAction[] = [];
  let copied = 0, merged = 0, skipped = 0, conflicts = 0, added = 0;

  for (const path of allPaths) {
    const ls = localMap.get(path);
    const rs = remoteMap.get(path);
    const target: 'local' | 'remote' = direction === 'pull' ? 'local' : 'remote';

    if (ls && !rs) {
      // Only on one side - copy to the other
      if (direction === 'push') {
        actions.push({ path, action: 'copy', target: 'remote', added: 0, reason: 'local only' });
        copied++;
      } else {
        // pull: remote doesn't have it, but we are pulling, so nothing to do? Actually local only means no action for pull
        actions.push({ path, action: 'skip', target: 'local', added: 0, reason: 'local only, pull skips' });
        skipped++;
      }
      continue;
    }
    if (!ls && rs) {
      if (direction === 'pull') {
        actions.push({ path, action: 'copy', target: 'local', added: 0, reason: 'remote only' });
        copied++;
      } else {
        actions.push({ path, action: 'skip', target: 'remote', added: 0, reason: 'remote only, push skips' });
        skipped++;
      }
      continue;
    }
    if (ls && rs) {
      if (ls.sha256 === rs.sha256) {
        actions.push({ path, action: 'skip', target, added: 0, reason: 'identical' });
        skipped++;
        continue;
      }
      // Different content - need to merge if eligible
      const localContent = localContents.get(path);
      const remoteContent = remoteContents.get(path);
      if (!localContent || !remoteContent) {
        actions.push({ path, action: 'conflict', target, added: 0, reason: 'missing content' });
        conflicts++;
        continue;
      }
      // For markdown and jsonl, use mergeDelimited to compute added
      if (path.endsWith('.md') || path.endsWith('.jsonl')) {
        try {
          const result = mergeDelimited(localContent.toString('utf-8'), remoteContent.toString('utf-8'));
          const addedPositive = typeof result.added === 'number' ? result.added : 0;
          actions.push({ path, action: 'merge', target, added: addedPositive, reason: 'content differs, merge', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
          merged++;
          added += addedPositive;
        } catch {
          actions.push({ path, action: 'conflict', target, added: 0, reason: 'merge failed' });
          conflicts++;
        }
      } else if (path.endsWith('.zstd')) {
        // For sessions, mark as merge with 1 added (binary safe, actual merge in Task 4)
        actions.push({ path, action: 'merge', target, added: 1, reason: 'session differs', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
        merged++;
        added += 1;
      } else {
        actions.push({ path, action: 'conflict', target, added: 0, reason: 'unknown kind' });
        conflicts++;
      }
    }
  }

  const revision = revisionFrom([...localSnapshots, ...remoteSnapshots], direction);
  const summary: SyncSummary = { copied, merged, skipped, conflicts, added };
  return { revision, actions, summary };
}

export async function buildPreview(
  localSnapshots: FileSnapshot[],
  remoteSnapshots: FileSnapshot[],
  direction: SyncDirection,
  localContents: Map<string, Buffer>,
  remoteContents: Map<string, Buffer>,
): Promise<SyncPreview> {
  const plan = await buildPlan(localSnapshots, remoteSnapshots, direction, localContents, remoteContents);
  const previewId = randomBytes(8).toString('hex');
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const preview: SyncPreview = { ...plan, previewId, expiresAt };
  storePreview(preview);
  return preview;
}
