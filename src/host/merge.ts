/**
 * Core delimited merge for daily/projects/global memories.
 * Ported from packages/dsh-maestro-memory/src/host/storage/atomic-store.ts
 * with header-aware parsing for DSH sync.
 */

/** Entry delimiter, byte-compatible with Hermes MEMORY.md / USER.md. */
export const ENTRY_DELIMITER = '\n§\n';

/** Regex for entry ID prefix (space after colon allowed, case-insensitive). */
export const ENTRY_ID_RE = /^\[id:\s*[0-9a-f]{8}\]\s*/i;

/**
 * Strip the `[id:xxxxxxxx]` prefix from an entry, if present.
 */
export function stripId(entry: string): string {
  return String(entry ?? '').replace(ENTRY_ID_RE, '');
}

/** Alias for compatibility. */
export const stripEntryId = stripId;

/**
 * Extract leading HTML comment header `<!--...-->` if present at start of text.
 * Returns header (trimmed) and remaining body.
 */
function extractHeader(text: string): { header: string; body: string } {
  const raw = String(text ?? '');
  const match = /^\s*<!--[\s\S]*?-->\s*/.exec(raw);
  if (match) {
    const header = match[0].trim();
    const body = raw.slice(match[0].length);
    return { header, body };
  }
  return { header: '', body: raw };
}

/**
 * Split raw file text into trimmed, non-empty entries.
 * Strips leading `<!--...-->` header before splitting.
 */
export function parseEntries(text: string): string[] {
  const { body } = extractHeader(String(text ?? ''));
  // Split strictly by ENTRY_DELIMITER, then trim and filter.
  // For robustness, also handle cases where delimiter may have surrounding spaces
  // by normalizing split result via trim.
  return body
    .split(ENTRY_DELIMITER)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/**
 * Serialize entries into canonical file text.
 */
export function serializeEntries(entries: string[]): string {
  return entries.length === 0 ? '' : entries.join(ENTRY_DELIMITER) + '\n';
}

/**
 * Merge two delimited texts, dedup by stripId, preserve local order then remote-only appended.
 * Header comment (`<!--...-->`) is preserved from local if present, otherwise from remote.
 * @returns merged text and count of added entries.
 */
export function mergeDelimited(
  localText: string,
  remoteText: string,
): { mergedText: string; added: number } {
  const localHeader = extractHeader(String(localText ?? '')).header;
  const remoteHeader = extractHeader(String(remoteText ?? '')).header;
  const header = localHeader || remoteHeader || '';

  const localEntries = parseEntries(String(localText ?? ''));
  const remoteEntries = parseEntries(String(remoteText ?? ''));

  const seen = new Set<string>(localEntries.map((e) => stripId(e)));
  const merged = [...localEntries];
  let added = 0;

  for (const entry of remoteEntries) {
    const key = stripId(entry);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
      added++;
    }
  }

  const body = serializeEntries(merged);
  let mergedText: string;
  if (header) {
    if (body === '') {
      mergedText = header + '\n';
    } else {
      mergedText = header + '\n' + body;
    }
  } else {
    mergedText = body;
  }

  return { mergedText, added };
}
