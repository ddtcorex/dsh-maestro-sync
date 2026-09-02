// src/host/remote-manifest.ts — one-pass remote inventory of eligible files.
//
// The fixed remote script walks only the eligible subtrees (same prune rules
// as transport.list), emits "sha<TAB>size<TAB>mtime<TAB>rel\0" per file, and
// the parser validates every relative path via normalizeEligiblePath before it
// can enter a plan. NUL framing keeps any discovered name safe on the wire;
// the parser sorts deterministically. mtimeSec is informational only — it is
// never an equality proof (equality uses sha256+size).
import { normalizeEligiblePath } from './validation.js';

export interface RemoteManifestEntry {
  path: string;
  sha256: string;
  size: number;
  mtimeSec: number;
}

export function buildRemoteManifestScript(dshRoot: string): string {
  // Fixed script; dshRoot is the validated absolute root (same trust rule as transport.list).
  return [
    `find ${dshRoot}/memories ${dshRoot}/sessions`,
    `\\( -name node_modules -o -name .git -o -name .supervisor -o -name profiles \\) -prune -o -type f -print0`,
    `| while IFS= read -r -d '' f; do`,
    `rel=\${f#${dshRoot}/}`,
    `sha=$(sha256sum -- "$f" | awk '{print $1}')`,
    `size=$(wc -c < "$f" 2>/dev/null || echo 0)`,
    `mtime=$(stat -c %Y -- "$f" 2>/dev/null || echo 0)`,
    `printf '%s\\t%s\\t%s\\t%s\\0' "$sha" "$size" "$mtime" "$rel"`,
    `done`,
  ].join(' ');
}

export function parseRemoteManifest(buf: Buffer): RemoteManifestEntry[] {
  const out: RemoteManifestEntry[] = [];
  const parts = buf.toString('utf-8').split('\0');
  for (const part of parts) {
    if (!part) continue;
    const [sha, sizeRaw, mtimeRaw, ...rest] = part.split('\t');
    const p = rest.join('\t');
    const size = Number(sizeRaw);
    const mtimeSec = Number(mtimeRaw);
    if (!sha || !p || !Number.isFinite(size) || !Number.isFinite(mtimeSec)) continue;
    try {
      normalizeEligiblePath(p);
    } catch {
      continue; // ineligible — never enters the plan
    }
    out.push({ path: p, sha256: sha, size, mtimeSec });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}