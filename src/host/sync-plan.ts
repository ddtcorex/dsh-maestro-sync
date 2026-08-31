import { createHash, randomBytes } from 'node:crypto';
import type { FileSnapshot, PlannedAction, SyncPlan, SyncPreview, SyncSummary, SyncDirection } from './sync-types.js';
import { mergeDelimited } from './merge.js';
import { mergeZstdLines } from './session-merge.js';

export const PREVIEW_TTL_MS = 60_000;
export const MAX_PREVIEWS = 50;

const previews = new Map<string, SyncPreview>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, p] of previews.entries()) {
    if (new Date(p.expiresAt).getTime() <= now) previews.delete(id);
  }
  if (previews.size > MAX_PREVIEWS) {
    const entries = [...previews.entries()].sort((a, b) => new Date(a[1].expiresAt).getTime() - new Date(b[1].expiresAt).getTime());
    const toDelete = previews.size - MAX_PREVIEWS;
    for (let i = 0; i < toDelete; i++) previews.delete(entries[i]![0]);
  }
}

export function storePreview(preview: SyncPreview): void {
  pruneExpired();
  if (previews.size >= MAX_PREVIEWS) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, p] of previews.entries()) {
      const t = new Date(p.expiresAt).getTime();
      if (t < oldestTime) {
        oldestTime = t;
        oldestId = id;
      }
    }
    if (oldestId) previews.delete(oldestId);
  }
  previews.set(preview.previewId, preview);
  const ttl = Math.max(0, new Date(preview.expiresAt).getTime() - Date.now());
  setTimeout(() => previews.delete(preview.previewId), ttl).unref?.();
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

export function revisionFrom(snapshots: FileSnapshot[], direction: SyncDirection): string {
  const h = createHash('sha256');
  h.update(direction);
  const sorted = [...snapshots].sort((a, b) => a.path.localeCompare(b.path));
  for (const s of sorted) {
    h.update(s.path + ':' + s.sha256 + ':' + String(s.size) + ':' + s.kind);
  }
  return h.digest('hex').slice(0, 16);
}

function unionJsonlAdded(localBuf: Buffer, remoteBuf: Buffer): number {
  const localLines = localBuf.toString('utf-8').split('\n').filter((l) => l.length > 0);
  const remoteLines = remoteBuf.toString('utf-8').split('\n').filter((l) => l.length > 0);
  const seen = new Set(localLines);
  let added = 0;
  for (const line of remoteLines) {
    if (!seen.has(line)) {
      seen.add(line);
      added++;
    }
  }
  return added;
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
  const allPaths = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);

  const actions: PlannedAction[] = [];
  let copied = 0;
  let merged = 0;
  let skipped = 0;
  let conflicts = 0;
  let added = 0;

  const sortedPaths = [...allPaths].sort((a, b) => a.localeCompare(b));

  for (const p of sortedPaths) {
    const ls = localMap.get(p);
    const rs = remoteMap.get(p);
    const target: 'local' | 'remote' = direction === 'pull' ? 'local' : 'remote';

    if (ls && !rs) {
      if (direction === 'push') {
        actions.push({ path: p, action: 'copy', target: 'remote', added: 0, reason: 'local only', expectedTargetSha256: undefined });
        copied++;
      } else {
        actions.push({ path: p, action: 'skip', target: 'local', added: 0, reason: 'local only, pull skips' });
        skipped++;
      }
      continue;
    }
    if (!ls && rs) {
      if (direction === 'pull') {
        actions.push({ path: p, action: 'copy', target: 'local', added: 0, reason: 'remote only' });
        copied++;
      } else {
        actions.push({ path: p, action: 'skip', target: 'remote', added: 0, reason: 'remote only, push skips' });
        skipped++;
      }
      continue;
    }
    if (ls && rs) {
      if (ls.sha256 === rs.sha256) {
        actions.push({ path: p, action: 'skip', target, added: 0, reason: 'identical bytes', expectedTargetSha256: ls.sha256 });
        skipped++;
        continue;
      }
      const localBuf = localContents.get(p);
      const remoteBuf = remoteContents.get(p);
      if (!localBuf || !remoteBuf) {
        actions.push({ path: p, action: 'conflict', target, added: 0, reason: 'missing content for merge', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
        conflicts++;
        continue;
      }

      try {
        if (p.endsWith('.md')) {
          const localStr = localBuf.toString('utf-8');
          const remoteStr = remoteBuf.toString('utf-8');
          const { added: addedCount } = direction === 'pull' ? mergeDelimited(localStr, remoteStr) : mergeDelimited(remoteStr, localStr);
          actions.push({ path: p, action: 'merge', target, added: addedCount, reason: 'content differs, merge', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
          merged++;
          added += addedCount;
        } else if (p.endsWith('.jsonl')) {
          const addedCount = direction === 'pull' ? unionJsonlAdded(localBuf, remoteBuf) : unionJsonlAdded(remoteBuf, localBuf);
          actions.push({ path: p, action: 'merge', target, added: addedCount, reason: 'content differs, merge', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
          merged++;
          added += addedCount;
        } else if (p.endsWith('.zstd')) {
          const localStr = localBuf.toString('utf-8');
          const remoteStr = remoteBuf.toString('utf-8');
          const { added: addedCount } = direction === 'pull' ? mergeZstdLines(localStr, remoteStr) : mergeZstdLines(remoteStr, localStr);
          actions.push({ path: p, action: 'merge', target, added: addedCount, reason: 'session differs, merge', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
          merged++;
          added += addedCount;
        } else {
          actions.push({ path: p, action: 'conflict', target, added: 0, reason: 'unknown kind', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
          conflicts++;
        }
      } catch (e: any) {
        actions.push({ path: p, action: 'conflict', target, added: 0, reason: e?.message ?? 'merge failed', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
        conflicts++;
      }
    }
  }

  const revision = revisionFrom([...localSnapshots, ...remoteSnapshots], direction);
  const summary: SyncSummary = { copied, merged, skipped, conflicts, added };
  actions.sort((a, b) => a.path.localeCompare(b.path));
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
  const previewId = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  const preview: SyncPreview = { ...plan, previewId, expiresAt };
  storePreview(preview);
  return preview;
}
