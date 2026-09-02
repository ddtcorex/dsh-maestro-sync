// src/host/fingerprint.ts — persistent stat->sha256 index (a pure speed hint).
//
// The cache NEVER proves equality on its own: entry.key is trusted only when
// dev+ino+size+mtimeNs+ctimeNs all match the current stat, and every file a
// plan will write is freshly read+hashed at write time (see sync-service).
// mtime+size alone is never an equality proof — a same-size rewrite preserves
// them; ctimeNs closes that gap (ctime always changes on a write).
import * as fsMod from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface FpEntry {
  dev: number;
  ino: number;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  sha256: string;
}

export interface FingerprintIndex {
  schema: 1;
  rootKey: string;
  entries: Record<string, FpEntry>;
}

const FILE = 'index.json';

function toNs(v: unknown, ms: unknown): bigint {
  if (v !== undefined && v !== null) {
    try {
      return BigInt(v as bigint | number | string);
    } catch {
      // fall through to ms-derived approximation
    }
  }
  return BigInt(Math.trunc((typeof ms === 'number' && Number.isFinite(ms) ? ms : 0) * 1e6));
}

/**
 * Stable stat fingerprint. Prefer stats from `statSync(p, { bigint: true })`;
 * the mtime/ctime nanoseconds are then exact. Non-bigint stats fall back to an
 * ms-derived approximation, which still changes on any write via ctime.
 */
export function statFingerprint(st: any): { dev: number; ino: number; size: number; mtimeNs: string; ctimeNs: string } {
  return {
    dev: Number(st.dev ?? 0),
    ino: Number(st.ino ?? 0),
    size: Number(st.size ?? 0),
    mtimeNs: String(toNs(st.mtimeNs, st.mtimeMs)),
    ctimeNs: String(toNs(st.ctimeNs, st.ctimeMs)),
  };
}

export function matchesStat(entry: FpEntry, st: any): boolean {
  const k = statFingerprint(st);
  return entry.dev === k.dev && entry.ino === k.ino && entry.size === k.size && entry.mtimeNs === k.mtimeNs && entry.ctimeNs === k.ctimeNs;
}

export function loadIndex(dir: string): FingerprintIndex {
  try {
    const raw = JSON.parse(fsMod.readFileSync(path.join(dir, FILE), 'utf-8')) as { schema?: number; rootKey?: string; entries?: Record<string, FpEntry> };
    if (raw?.schema !== 1 || !raw.entries || typeof raw.rootKey !== 'string') return { schema: 1, rootKey: '', entries: {} };
    return { schema: 1, rootKey: raw.rootKey, entries: raw.entries };
  } catch {
    return { schema: 1, rootKey: '', entries: {} };
  }
}

export function saveIndex(dir: string, index: FingerprintIndex): void {
  fsMod.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, FILE);
  const tmp = `${target}.tmp.${randomBytes(4).toString('hex')}`;
  fsMod.writeFileSync(tmp, JSON.stringify(index), 'utf-8');
  try {
    fsMod.chmodSync(tmp, 0o600);
  } catch {}
  fsMod.renameSync(tmp, target);
}

export function probeIndex(rel: string, index: FingerprintIndex): FpEntry | null {
  return index.entries[rel] ?? null;
}