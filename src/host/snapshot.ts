import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { normalizeEligiblePath } from './validation.js';
import type { FileSnapshot } from './sync-types.js';

export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function kindForPath(p: string): FileSnapshot['kind'] {
  const normalized = p; // caller should have validated; we still dispatch by suffix
  if (normalized.endsWith('.zstd')) return 'session';
  if (normalized.endsWith('.jsonl')) return 'jsonl';
  return 'memory';
}

export function snapshotFile(validatedPath: string, content: Buffer): FileSnapshot {
  const normalized = normalizeEligiblePath(validatedPath);
  const sha256 = hashBuffer(content);
  const kind = kindForPath(normalized);
  return { path: normalized, sha256, size: content.length, kind };
}

/**
 * Collect snapshots for all eligible files under root using the provided fs.
 * - Walks recursively via fs.readdirSync/statSync/readFileSync when available.
 * - Validates each discovered relative path via normalizeEligiblePath.
 * - Hashes file bytes with SHA-256 and records kind.
 * Returns sorted snapshots by path for determinism.
 */
export function collectSnapshots(root: string, fs: any): FileSnapshot[] {
  const result: FileSnapshot[] = [];
  if (!root || typeof root !== 'string') return result;
  const fsMod = fs ?? {};
  // Check root exists
  try {
    if (fsMod.existsSync && !fsMod.existsSync(root)) return [];
  } catch {
    return [];
  }

  const walk = (dir: string, base: string) => {
    let entries: any[] = [];
    try {
      if (typeof fsMod.readdirSync !== 'function') return;
      const raw = fsMod.readdirSync(dir, { withFileTypes: true } as any);
      if (!raw || raw.length === 0) return;
      // handle string[] mode (no withFileTypes)
      if (typeof raw[0] === 'string') {
        for (const name of raw as unknown as string[]) {
          const full = path.join(dir, name);
          let st: any = null;
          try {
            st = fsMod.statSync ? fsMod.statSync(full) : null;
          } catch {
            continue;
          }
          const isDir = st && typeof st.isDirectory === 'function' ? st.isDirectory() : false;
          if (isDir) walk(full, path.join(base, name));
          else {
            const relPosix = path.join(base, name).split(path.sep).join('/');
            try {
              normalizeEligiblePath(relPosix);
            } catch {
              continue;
            }
            try {
              let buf: Buffer;
              if (typeof fsMod.readFileSync === 'function') {
                const data = fsMod.readFileSync(full);
                buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
              } else {
                continue;
              }
              result.push(snapshotFile(relPosix, buf));
            } catch {
              // skip unreadable
            }
          }
        }
        return;
      }
      for (const ent of raw as any[]) {
        const name = ent.name ?? String(ent);
        const full = path.join(dir, name);
        const isDir = typeof ent.isDirectory === 'function' ? ent.isDirectory() : false;
        if (isDir) {
          walk(full, path.join(base, name));
        } else {
          const relPosix = path.join(base, name).split(path.sep).join('/');
          try {
            normalizeEligiblePath(relPosix);
          } catch {
            continue;
          }
          try {
            let buf: Buffer;
            if (typeof fsMod.readFileSync === 'function') {
              const data = fsMod.readFileSync(full);
              buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
            } else continue;
            result.push(snapshotFile(relPosix, buf));
          } catch {
            // skip
          }
        }
      }
    } catch {
      // walk errors are ignored
    }
  };

  walk(root, '');
  // Deterministic sort
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

/**
 * Snapshot a specific list of validated eligible paths under root.
 * Useful for hashing staged remote files where we already know the manifest.
 */
export function snapshotPaths(root: string, paths: string[], fs: any): FileSnapshot[] {
  const fsMod = fs ?? {};
  const out: FileSnapshot[] = [];
  for (const p of paths) {
    let normalized: string;
    try {
      normalized = normalizeEligiblePath(p);
    } catch {
      continue;
    }
    const full = path.join(root, normalized);
    try {
      if (fsMod.existsSync && !fsMod.existsSync(full)) continue;
      if (typeof fsMod.readFileSync !== 'function') continue;
      const data = fsMod.readFileSync(full);
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
      out.push(snapshotFile(normalized, buf));
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Snapshot from an in-memory map of path -> Buffer (useful for testing staged remote).
 */
export function snapshotFromMap(contents: Map<string, Buffer>): FileSnapshot[] {
  const out: FileSnapshot[] = [];
  for (const [p, buf] of contents.entries()) {
    try {
      out.push(snapshotFile(p, buf));
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
