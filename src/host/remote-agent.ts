/**
 * Remote commit agent for dsh-maestro-sync.
 *
 * The only remote code executed by the transport is this fixed, versioned
 * POSIX sh helper. It is installed under `<dshRoot>/.maestro-sync/bin/`
 * (`ensureAgent`) and invoked as a fixed protocol command with one argv item
 * (the operationId); the only dynamic data that crosses to the remote is the
 * JSONL manifest on stdin, whose paths were validated as eligible beforehand.
 *
 * CAS semantics (compare-and-swap, fail closed):
 * - expected `<sha256>`: the current target must hash to exactly that value;
 *   any mismatch (or a vanished target) is CONCURRENT_MODIFICATION and the
 *   target is never overwritten.
 * - expected `absent`: the target must not exist; if it appeared concurrently
 *   the publish is rejected.
 * - On success the helper backs the target up beside the file, then atomically
 *   renames the staged artifact into place (`mv` on the same filesystem).
 * - Any failure exits non-zero; no partial overwrite ever occurs.
 */
export const REMOTE_AGENT_NAME = 'maestro-sync-commit';
export const REMOTE_AGENT_REL = '.maestro-sync/bin/maestro-sync-commit';

export function remoteAgentSource(): string {
  return `#!/bin/sh
# maestro-sync-commit — fixed remote CAS publisher for dsh-maestro-sync.
# Usage: maestro-sync-commit <operationId>
# Reads a JSONL manifest from stdin. Each line is one object:
#   {"path":"<eligible rel path>","expected":"<sha256 hex>|absent"}
# Staged artifacts live under <dshRoot>/.maestro-sync/stage/<operationId>/<path>.
# Publishes to <dshRoot>/<path> only after compare-and-swap; on mismatch it
# reports CONCURRENT_MODIFICATION and never overwrites. Committed targets are
# backed up beside the file as <path>.bak.<ts>.<pid>. Any failure exits non-zero.
set -u

die() { echo "maestro-sync-commit: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || die "usage: maestro-sync-commit <operationId>"
op="$1"

# The helper lives at <dshRoot>/.maestro-sync/bin/maestro-sync-commit, so the
# DSH root is two levels up from $0 (no local shell ever expands it).
self="$0"
dsh_root=$(CDPATH= cd -- "$(dirname -- "$self")/../.." 2>/dev/null && pwd) || die "cannot resolve dsh root from $self"
[ -n "$dsh_root" ] || die "empty dsh root"

stage_dir="$dsh_root/.maestro-sync/stage/$op"
[ -d "$stage_dir" ] || die "no staged operation $op under $dsh_root/.maestro-sync"

# sha256sum is coreutils; fall back to macOS shasum for dev hosts.
if ! command -v sha256sum >/dev/null 2>&1; then
  sha256sum() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

fail=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in
    '{'*) ;;
    *) echo "maestro-sync-commit: invalid manifest line" >&2; fail=1; continue ;;
  esac
  rel=$(printf '%s' "$line" | sed -n 's/^.*"path":"\\([^"]*\\)".*$/\\1/p')
  expected=$(printf '%s' "$line" | sed -n 's/^.*"expected":"\\([^"]*\\)".*$/\\1/p')
  [ -n "$rel" ] || { echo "maestro-sync-commit: manifest line without path" >&2; fail=1; continue; }
  case "$rel" in
    /*|*..*|*' '*|*'"'*|*"'"'*|*'\\'*)
      echo "maestro-sync-commit: unsafe path in manifest: $rel" >&2; fail=1; continue ;;
  esac
  staged="$stage_dir/$rel"
  [ -f "$staged" ] || { echo "maestro-sync-commit: missing staged artifact: $rel" >&2; fail=1; continue; }
  target="$dsh_root/$rel"
  if [ "$expected" = "absent" ]; then
    if [ -e "$target" ]; then
      echo "CONCURRENT_MODIFICATION: $rel (target exists, expected absent)" >&2
      fail=1
      continue
    fi
  else
    case "$expected" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
      *) echo "maestro-sync-commit: invalid expected hash for $rel" >&2; fail=1; continue ;;
    esac
    if [ -f "$target" ]; then
      actual=$(sha256sum "$target" 2>/dev/null | awk '{print $1}') || { echo "maestro-sync-commit: cannot hash $rel" >&2; fail=1; continue; }
      if [ "$actual" != "$expected" ]; then
        echo "CONCURRENT_MODIFICATION: $rel (target sha256 $actual != expected $expected)" >&2
        fail=1
        continue
      fi
    else
      echo "CONCURRENT_MODIFICATION: $rel (target vanished)" >&2
      fail=1
      continue
    fi
  fi
  if [ -f "$target" ]; then
    bak="$target.bak.$(date +%s).$$"
    if ! cp -p "$target" "$bak" 2>/dev/null; then
      echo "maestro-sync-commit: backup failed for $rel" >&2
      fail=1
      continue
    fi
  fi
  if ! mkdir -p "$(dirname -- "$target")" 2>/dev/null; then
    echo "maestro-sync-commit: cannot create target dir for $rel" >&2
    fail=1
    continue
  fi
  if ! mv "$staged" "$target" 2>/dev/null; then
    echo "maestro-sync-commit: publish failed for $rel" >&2
    fail=1
    continue
  fi
  echo "committed $rel"
done
[ "$fail" -eq 0 ] || exit 1
exit 0
`;
}

/**
 * Structural verification of the helper source — used by tests and by
 * `ensureAgent` before shipping the script to the remote host.
 */
export function verifyRemoteAgentSource(src: string): string {
  if (!src.startsWith('#!/bin/sh')) throw new Error('remote agent must be POSIX sh');
  if (src.includes('[[ ')) throw new Error('remote agent must not use bash [[ ]]');
  if (/\bfunction\s+/.test(src)) throw new Error('remote agent must not use bash function keyword');
  if (!src.includes('CONCURRENT_MODIFICATION')) throw new Error('remote agent must implement CAS');
  if (!src.includes('.maestro-sync/stage/')) throw new Error('remote agent must read staged artifacts');
  if (!src.includes('sha256')) throw new Error('remote agent must hash targets');
  return src;
}