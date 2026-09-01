import type { RemoteTarget } from './sync-types.js';

export const HOST_RE = /^(?!-)[A-Za-z0-9._@:-]+$/;
export const ABSOLUTE_RE = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
export const ELIGIBLE_RE =
  /^(?:memories\/(?!.*\.bak\.)[A-Za-z0-9._\/-]+\.md|memories\/SUGGESTIONS\.jsonl|sessions\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/session\.jsonl\.zstd|sessions\/[A-Za-z0-9._\/-]+\.jsonl\.zstd)$/;

// Backwards-compatible aliases required by spec
export const HOST = HOST_RE;
export const ABSOLUTE = ABSOLUTE_RE;
export const ELIGIBLE = ELIGIBLE_RE;

function containsControlChars(s: string): boolean {
  // Reject NUL, newline, carriage return, and other C0 controls
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function containsWhitespace(s: string): boolean {
  return /\s/.test(s);
}

function containsShellMeta(s: string): boolean {
  // Shell metachars that must not appear in host/path even if regex would catch some
  // Keep validation explicit and fail-closed
  return /[;`$|&><*?'"\\(){}!]/.test(s);
}

export function validateHost(host: string): string {
  if (typeof host !== 'string' || host.length === 0) throw new Error('host must be a non-empty string');
  if (containsControlChars(host) || host.includes('\u0000')) throw new Error(`invalid host: contains control characters`);
  if (!HOST_RE.test(host)) throw new Error(`invalid host: ${JSON.stringify(host)} does not match ${HOST_RE}`);
  if (containsWhitespace(host) || containsShellMeta(host) || host.includes('=')) {
    throw new Error(`invalid host: ${JSON.stringify(host)} contains illegal characters`);
  }
  return host;
}

export function validateRemoteTarget(value: RemoteTarget): RemoteTarget {
  if (!value || typeof value.host !== 'string' || typeof value.dshRoot !== 'string') {
    throw new Error('RemoteTarget must have string host and dshRoot');
  }
  const { host, dshRoot } = value;
  validateHost(host);

  if (!ABSOLUTE_RE.test(dshRoot)) {
    throw new Error(`invalid dshRoot: ${JSON.stringify(dshRoot)} does not match ${ABSOLUTE_RE}`);
  }

  // Additional fail-closed checks: reject traversal, ~, //, trailing slash already covered
  if (dshRoot.includes('~')) {
    throw new Error(`invalid dshRoot: must be absolute without ~ expansion: ${JSON.stringify(dshRoot)}`);
  }
  if (dshRoot.includes('..')) {
    throw new Error(`invalid dshRoot: must not contain traversal: ${JSON.stringify(dshRoot)}`);
  }
  if (containsWhitespace(dshRoot) || containsShellMeta(dshRoot)) {
    throw new Error(`invalid dshRoot: contains whitespace or shell metacharacters`);
  }

  return { host, dshRoot };
}

export function normalizeEligiblePath(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('path must be a string');
  }
  if (value.length === 0) throw new Error('path must not be empty');
  if (containsControlChars(value) || value.includes('\u0000')) {
    throw new Error(`ineligible path: contains control characters: ${JSON.stringify(value)}`);
  }
  if (value.includes('..')) {
    // traversal not allowed at all; eligible paths are strictly under memories/ or sessions/
    // The ELIGIBLE regex would reject it anyway, but be explicit
    throw new Error(`ineligible path: traversal: ${JSON.stringify(value)}`);
  }
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    throw new Error(`ineligible path: must be relative eligible path: ${JSON.stringify(value)}`);
  }
  if (!ELIGIBLE_RE.test(value)) {
    throw new Error(`ineligible path: ${JSON.stringify(value)} does not match ${ELIGIBLE_RE}`);
  }
  // Extra sanity: already checked NUL, but also forbid backslash (Windows sep) and absolute
  if (value.includes('\\')) {
    throw new Error(`ineligible path: must use POSIX separators: ${JSON.stringify(value)}`);
  }
  return value;
}
