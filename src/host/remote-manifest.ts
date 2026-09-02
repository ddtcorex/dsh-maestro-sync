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
  // Cache-aware, READ-ONLY (spec §4.7 clarification, decision C): it consults
  // <root>/.maestro-sync/fp.tsv and reuses a cached sha256 when the file's
  // ino+size+mtimeNs+ctimeNs triple (GNU stat '%.Y'/'%.Z' ns fractions) still
  // matches, skipping sha256sum for unchanged files. The cache is loaded ONCE
  // in a single awk pass, read straight from the file inside awk (getline — a
  // `-v cache=...` copy exceeds the 128 KiB per-arg limit once fp.tsv grows,
  // E2BIG "Argument list too long", measured 2026-09-02); only MISS records are
  // sha256sum'd in the bash loop. NEVER writes.
  // Every loop-body statement must end with ';' — space-separated assignments
  // inside a `do...done` one-liner break bash's parser (verified 2026-09-02).
  const cache = remoteCachePath(dshRoot);
  return [
    `find ${dshRoot}/memories ${dshRoot}/sessions`,
    `\\( -name node_modules -o -name .git -o -name .supervisor -o -name profiles \\) -prune -o -type f -print0`,
    `| xargs -0 stat --printf='%i %s %.Y %.Z\\t%n\\n' 2>/dev/null`,
    `| awk -F '\\t' -v root='${dshRoot}/' -v cachefile='${cache}' 'BEGIN{while((getline line < cachefile) > 0){if(line=="")continue; m=split(line,a,"\\t"); if(m>=6){c[a[1]]=(a[2]" "a[3]" "a[4]" "a[5])"\\t"a[6]"\\t"a[3]"\\t"a[4];}} close(cachefile);} {st=$1; rel=$2; sub(root,"",rel); if(rel in c){split(c[rel],e,"\\t"); if(e[1]==st){print "H\\t"rel"\\t"e[2]"\\t"e[3]"\\t"e[4]; next;}} print "M\\t"rel"\\t"st;}'`,
    `| while IFS= read -r rec; do`,
    `tag=\${rec%%$'\\t'*}; rest=\${rec#*$'\\t'};`,
    `if [ "$tag" = "H" ]; then`,
    `rel=\${rest%%$'\\t'*}; rest=\${rest#*$'\\t'}; sha=\${rest%%$'\\t'*}; rest=\${rest#*$'\\t'}; size=\${rest%%$'\\t'*}; mtime=\${rest#*$'\\t'};`,
    `printf '%s\\t%s\\t%s\\t%s\\0' "$sha" "$size" "$mtime" "$rel";`,
    `else`,
    `rel=\${rest%%$'\\t'*}; st=\${rest#*$'\\t'};`,
    `sha=$(sha256sum -- "${dshRoot}/$rel" 2>/dev/null | awk '{print $1}');`,
    `set -- $st;`,
    `printf '%s\\t%s\\t%s\\t%s\\0' "$sha" "$2" "$3" "$rel";`,
    `fi;`,
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