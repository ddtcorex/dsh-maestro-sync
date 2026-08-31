import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FileSnapshot } from './sync-types.js';
import { normalizeEligiblePath } from './validation.js';

export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function snapshotFile(path: string, content: Buffer): Promise<FileSnapshot> {
  const normalized = normalizeEligiblePath(path);
  const sha256 = hashBuffer(content);
  let kind: FileSnapshot['kind'] = 'memory';
  if (normalized.endsWith('.jsonl')) kind = 'jsonl';
  else if (normalized.endsWith('.zstd')) kind = 'session';
  return { path: normalized, sha256, size: content.length, kind };
}

export async function snapshotLocalFile(path: string, localRoot: string): Promise<FileSnapshot> {
  const full = `${localRoot}/${path}`;
  const content = await readFile(full);
  return snapshotFile(path, content);
}
