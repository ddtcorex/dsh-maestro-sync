// src/host/remote-manifest.ts — one-pass remote inventory of eligible files.
//
// The fixed remote script walks only the eligible subtrees (same prune rules
// as transport.list), emits "sha<TAB>size<TAB>mtime<TAB>rel\0" per file, and
// the parser validates every relative path via normalizeEligiblePath before it
// can enter a plan. NUL framing keeps any discovered name safe on the wire;
// the parser sorts deterministically. mtimeSec is informational only — it is
// never an equality proof (equality uses sha256+size).
import { normalizeEligiblePath } from './validation.js';
import { remoteCachePath } from './remote-cache.js';

export interface RemoteManifestEntry {
  path: string;
  sha256: string;
  size: number;
  mtimeSec: number;
}

export function buildRemoteManifestScript(dshRoot: string): string {
  // Fixed script; dshRoot is the validated absolute root (same trust rule as transport.list).
  // Cache-aware, READ-ONLY: it consults <root>/.maestro-sync/fp.tsv and reuses a
  // cached sha256 when the file's ino+size+mtimeNs+ctimeNs triple (GNU stat
  // '%.Y'/'%.Z' ns fractions) still matches, skipping sha256sum for unchanged
  // files. It NEVER writes — the cache is refreshed only by the warm script
  // (push-apply / explicit warm command), so preview stays strictly read-only.
  // Every loop-body statement must end with ';' — space-separated assignments
  // inside a `do...done` one-liner break bash's parser ("unexpected end of file
  // from while"), verified 2026-09-02 (commit f4b5892).
  const cache = remoteCachePath(dshRoot);
  const body = [
    `st=\${rec%%$'\\t'*}; abs=\${rec#*$'\\t'}; rel=\${abs#${dshRoot}/};`,
    `hit="";`,
    `[ "$LOOKUP" = "1" ] && hit=$(printf '%s\\n' "$cache"`,
    `| awk -F '\\t' -v r="$rel" -v s="$st" '$1==r && ($2" "$3" "$4" "$5)==s { print $6"\\t"$3"\\t"$4 }'`,
    `| head -n 1);`,
    `if [ -n "$hit" ]; then`,
    `sha=\${hit%%$'\\t'*}; size=\${hit#*$'\\t'}; size=\${size%%$'\\t'*}; mtime=\${hit##*$'\\t'};`,
    `printf '%s\\t%s\\t%s\\t%s\\0' "$sha" "$size" "$mtime" "$rel";`,
    `else`,
    `sha=$(sha256sum -- "${dshRoot}/$rel" 2>/dev/null | awk '{print $1}');`,
    `set -- $st;`,
    `mtime="$3";`,
    `printf '%s\\t%s\\t%s\\t%s\\0' "$sha" "$2" "$mtime" "$rel";`,
    `fi;`,
  ].join(' ');
  return [
    `LOOKUP=0; [ -s "${cache}" ] && LOOKUP=1;`,
    `cache="$(cat ${cache} 2>/dev/null || true)";`,
    `find ${dshRoot}/memories ${dshRoot}/sessions`,
    `\\( -name node_modules -o -name .git -o -name .supervisor -o -name profiles \\) -prune -o -type f -print0`,
    `| xargs -0 stat --printf='%i %s %.Y %.Z\\t%n\\0' 2>/dev/null`,
    `| while IFS= read -r -d '' rec; do ${body} done`,
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