// src/host/remote-cache.ts — remote stat-keyed fingerprint cache (fp.tsv).
//
// The REMOTE-side counterpart of the local fingerprint index (§4.2, spec §4.7
// clarification, operator decision C 2026-09-02). It is a pure speed hint:
// - the manifest script READS fp.tsv and skips sha256sum when the file's
//   ino+size+mtimeNs+ctimeNs triple matches (GNU stat %.Y/%.Z ns fractions);
// - preview NEVER writes it — only push-apply or an explicit warm command runs
//   buildWarmCacheScript, which hashes misses and atomically renames the cache.
// Exactness never depends on the cache: a miss re-hashes; every write target is
// verified by CAS at publish.
import { normalizeEligiblePath } from './validation.js';

export const REMOTE_CACHE_REL = '.maestro-sync/fp.tsv';

export function remoteCachePath(dshRoot: string): string {
  return `${dshRoot}/${REMOTE_CACHE_REL}`;
}

export interface FpCacheEntry {
  ino: number;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  sha256: string;
}

/** Parse fp.tsv lines: `rel<TAB>ino<TAB>size<TAB>mtimeNs<TAB>ctimeNs<TAB>sha256`. */
export function parseFpCache(buf: Buffer): Map<string, FpCacheEntry> {
  const out = new Map<string, FpCacheEntry>();
  for (const line of buf.toString('utf-8').split('\n')) {
    if (!line.trim()) continue;
    const [rel, inoRaw, sizeRaw, mtimeNs, ctimeNs, sha256] = line.split('\t');
    if (!rel || !sha256) continue;
    try {
      normalizeEligiblePath(rel);
    } catch {
      continue;
    }
    const ino = Number(inoRaw);
    const size = Number(sizeRaw);
    if (!Number.isFinite(ino) || !Number.isFinite(size)) continue;
    out.set(rel, { ino, size, mtimeNs, ctimeNs, sha256 });
  }
  return out;
}

/**
 * Warm script: re-hash every eligible file fresh and rewrite fp.tsv atomically
 * (tmp + rename). Run ONLY from the push-apply path or an explicit warm
 * command — never from preview. One stat batch via xargs keeps fork counts low;
 * `set -- $st` splits the four stat fields (none contain whitespace).
 */
export function buildWarmCacheScript(dshRoot: string): string {
  const cache = remoteCachePath(dshRoot);
  return [
    `mkdir -p "${dshRoot}/.maestro-sync";`,
    `find ${dshRoot}/memories ${dshRoot}/sessions`,
    `\\( -name node_modules -o -name .git -o -name .supervisor -o -name profiles \\) -prune -o -type f -print0`,
    `| xargs -0 stat --printf='%i %s %.Y %.Z\\t%n\\0' 2>/dev/null`,
    `| while IFS= read -r -d '' rec; do`,
    `st=\${rec%%$'\\t'*}; abs=\${rec#*$'\\t'}; rel=\${abs#${dshRoot}/};`,
    `set -- $st;`,
    `sha=$(sha256sum -- "${dshRoot}/$rel" 2>/dev/null | awk '{print $1}');`,
    `printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$rel" "$1" "$2" "$3" "$4" "$sha";`,
    `done > "${cache}.tmp.$$";`,
    `mv "${cache}.tmp.$$" "${cache}";`,
  ].join(' ');
}