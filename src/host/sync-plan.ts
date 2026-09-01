import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { FileSnapshot, PlannedAction, SyncPlan, SyncPreview, SyncSummary, SyncDirection } from './sync-types.js';
import { mergeDelimited } from './merge.js';
import { isSameSession, mergeSessionBuffers } from './session-plan.js';

export const PREVIEW_TTL_MS = 60_000;
export const MAX_PREVIEWS = 50;

const previews = new Map<string, SyncPreview>();
const previewDirections = new Map<string, SyncDirection>();

function previewFile(id: string, dir: string): string {
  return path.join(dir, `${id}.json`);
}

/** Read a persisted preview record (null when missing/corrupt). */
function readPersisted(id: string, dir: string): { preview: SyncPreview; direction?: SyncDirection } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(previewFile(id, dir), 'utf-8')) as { preview?: SyncPreview; direction?: SyncDirection };
    if (!parsed || typeof parsed !== 'object' || typeof parsed.preview?.previewId !== 'string') return null;
    return { preview: parsed.preview, direction: parsed.direction };
  } catch {
    return null;
  }
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, p] of previews.entries()) {
    if (new Date(p.expiresAt).getTime() <= now) {
      previews.delete(id);
      previewDirections.delete(id);
    }
  }
  if (previews.size > MAX_PREVIEWS) {
    const entries = [...previews.entries()].sort((a, b) => new Date(a[1].expiresAt).getTime() - new Date(b[1].expiresAt).getTime());
    const toDelete = previews.size - MAX_PREVIEWS;
    for (let i = 0; i < toDelete; i++) {
      const delId = entries[i]![0];
      previews.delete(delId);
      previewDirections.delete(delId);
    }
  }
}

/**
 * Persist a preview to disk so a later process (a separate CLI apply) can
 * consume it. The file mirrors the in-memory record; the TTL is enforced on
 * read. Sidecar only — a plain operational folder under DSH_HOME, never part
 * of the eligible sync data.
 */
export function persistPreview(preview: SyncPreview, direction?: SyncDirection, dir?: string): string {
  if (!dir) return '';
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }
    // purge expired records, then cap at MAX_PREVIEWS (oldest first)
    const keep: string[] = [];
    for (const f of files) {
      if (f === `${preview.previewId}.json`) continue;
      const record = readPersisted(f.slice(0, -5), dir);
      if (record && new Date(record.preview.expiresAt).getTime() > now) keep.push(f);
      else {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {}
      }
    }
    keep.sort();
    while (keep.length >= MAX_PREVIEWS) {
      const old = keep.shift()!;
      try {
        fs.unlinkSync(path.join(dir, old));
      } catch {}
    }
    const target = previewFile(preview.previewId, dir);
    const tmp = target + `.tmp.${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify({ preview, direction }), 'utf-8');
    fs.renameSync(tmp, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {}
  } catch {
    // persistence is best-effort; the in-memory record still works in-process
  }
  return previewFile(preview.previewId, dir);
}

/** Delete every persisted preview file under dir (cleanup helper). */
export function clearPreviewStore(dir: string): void {
  if (!dir) return;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {}
      }
    }
  } catch {}
}

export function storePreview(preview: SyncPreview, direction?: SyncDirection, dir?: string): void {
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
    if (oldestId) {
      previews.delete(oldestId);
      previewDirections.delete(oldestId);
    }
  }
  previews.set(preview.previewId, preview);
  if (direction) previewDirections.set(preview.previewId, direction);
  if (dir) persistPreview(preview, direction, dir);
  const ttl = Math.max(0, new Date(preview.expiresAt).getTime() - Date.now());
  setTimeout(() => {
    previews.delete(preview.previewId);
    previewDirections.delete(preview.previewId);
  }, ttl).unref?.();
}

export function getPreview(id: string, dir?: string): SyncPreview | undefined {
  const cached = previews.get(id);
  if (cached) {
    if (new Date(cached.expiresAt).getTime() <= Date.now()) {
      previews.delete(id);
      previewDirections.delete(id);
      return undefined;
    }
    return cached;
  }
  if (!dir) return undefined;
  const record = readPersisted(id, dir);
  if (!record) return undefined;
  const p = record.preview;
  if (new Date(p.expiresAt).getTime() <= Date.now()) {
    try {
      fs.unlinkSync(previewFile(id, dir));
    } catch {}
    return undefined;
  }
  // hydrate into memory for single-process idempotence
  previews.set(p.previewId, p);
  if (record.direction) previewDirections.set(p.previewId, record.direction);
  return p;
}

export function getPreviewDirection(id: string): SyncDirection | undefined {
  return previewDirections.get(id);
}

export function deletePreview(id: string, dir?: string): void {
  previews.delete(id);
  previewDirections.delete(id);
  if (dir) {
    try {
      fs.unlinkSync(previewFile(id, dir));
    } catch {}
  }
}

export function clearPreviews(): void {
  previews.clear();
  previewDirections.clear();
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
          // Session handling is Buffer/path-only and preserves DSH standalone checksummed Zstd header frame.
          // Never convert Zstd bytes to UTF-8 string; use validated Zstd artifact API via session-plan.
          try {
            if (!isSameSession(localBuf, remoteBuf)) {
              actions.push({ path: p, action: 'conflict', target, added: 0, reason: 'session header mismatch', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
              conflicts++;
            } else {
              const { added: addedCount } = direction === 'pull' ? mergeSessionBuffers(localBuf, remoteBuf) : mergeSessionBuffers(remoteBuf, localBuf);
              actions.push({ path: p, action: 'merge', target, added: addedCount, reason: 'session differs, merge', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
              merged++;
              added += addedCount;
            }
          } catch (e: any) {
            actions.push({ path: p, action: 'conflict', target, added: 0, reason: e?.message ?? 'session merge failed', expectedTargetSha256: target === 'local' ? ls.sha256 : rs.sha256 });
            conflicts++;
          }
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
  storePreview(preview, direction);
  return preview;
}
