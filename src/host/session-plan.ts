/**
 * Binary-safe session planning for DSH Zstd artifacts.
 * Bytes remain bytes: .jsonl.zstd is staged and merged only through validated Zstd artifact API.
 * Session handling is Buffer/path-only and preserves DSH standalone checksummed Zstd header frame.
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xFD2FB528;
const ZSTD_CHECKSUM_OPTIONS = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
};

export interface SessionIdentity {
  /** decompressed header line Buffer (UTF-8 without trailing newline) */
  header: Buffer;
  sessionId: string;
  cwd: string;
}

interface ZstdFrameRange {
  start: number;
  end: number;
}

/** Locate complete Zstd frames, throwing on corrupt/truncated structure. Never converts Zstd bytes to string. */
function scanZstdFrames(source: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < source.length) {
    const start = offset;
    if (source.length - offset < 4 || source.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('corrupt Zstandard session artifact');
    }
    if (source.length - offset < 5) {
      throw new Error('incomplete Zstandard frame header');
    }
    offset += 4;
    const descriptor = source.readUInt8(offset++);
    if ((descriptor & 0x18) !== 0) throw new Error('corrupt Zstandard frame descriptor');

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const frameHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (source.length - offset < frameHeaderBytes) throw new Error('incomplete Zstandard frame header');
    offset += frameHeaderBytes;

    for (;;) {
      if (source.length - offset < 3) throw new Error('incomplete Zstandard frame block');
      const blockHeader = source.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('corrupt Zstandard frame block');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (source.length - offset < payloadBytes) throw new Error('incomplete Zstandard frame payload');
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if ((descriptor & 0x04) !== 0) {
      if (source.length - offset < 4) throw new Error('incomplete Zstandard frame checksum');
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return frames;
}

function parseHeaderLine(headerBytes: Buffer, label: string): { line: string; record: Record<string, unknown> } {
  if (headerBytes.length === 0 || headerBytes[headerBytes.length - 1] !== 0x0A) {
    throw new Error(`${label} session artifact has no standalone header frame`);
  }
  if (headerBytes.indexOf(0x0A) !== headerBytes.length - 1) {
    throw new Error(`${label} session artifact header frame not standalone`);
  }
  const line = headerBytes.subarray(0, -1).toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`${label} session artifact has an invalid session header`);
  }
  const record = value as Record<string, unknown> | null;
  const hasValidInteger = (field: string) => {
    const v = (record as any)?.[field];
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
  };
  if (
    record === null ||
    typeof record !== 'object' ||
    (record as any).type !== 'session' ||
    typeof (record as any).version !== 'number' ||
    typeof (record as any).id !== 'string' ||
    !hasValidInteger('createdAt') ||
    !hasValidInteger('delegationDepth') ||
    ((record as any).origin !== undefined && (record as any).origin !== 'subagent') ||
    ((record as any).agentPreset !== undefined && typeof (record as any).agentPreset !== 'string')
  ) {
    throw new Error(`${label} session artifact has an invalid session header`);
  }
  if ((record as any).cwd !== undefined && typeof (record as any).cwd !== 'string') {
    throw new Error(`${label} session artifact has an invalid session header`);
  }
  return { line, record: record as Record<string, unknown> };
}

/**
 * Validates Zstd header frame and extracts identity.
 * - Validates Zstd magic and frame structure via checksum-aware decompression.
 * - Decompresses only the first frame (standalone header) and validates JSONL header.
 * - Never converts raw Zstd bytes to UTF-8 string.
 */
export function parseSessionIdentity(buffer: Buffer): SessionIdentity {
  if (!Buffer.isBuffer(buffer)) throw new Error('session buffer must be Buffer');
  if (buffer.length === 0) throw new Error('empty session buffer');
  if (buffer.length < 4) throw new Error('corrupt Zstandard session artifact');
  if (buffer.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error('corrupt Zstandard session artifact');

  const frames = scanZstdFrames(buffer);
  if (frames.length === 0) throw new Error('session artifact has no Zstandard frames');

  let headerBytes: Buffer;
  try {
    headerBytes = zstdDecompressSync(buffer.subarray(frames[0]!.start, frames[0]!.end));
  } catch (e: any) {
    throw new Error(`invalid Zstd header frame: ${e?.message ?? String(e)}`);
  }

  const { line, record } = parseHeaderLine(headerBytes, 'session');

  const sessionId = String((record as any).id);
  const cwd = typeof (record as any).cwd === 'string' ? String((record as any).cwd) : '';
  const header = Buffer.from(line, 'utf8');
  return { header, sessionId, cwd };
}

/**
 * Compare header identity, not just path.
 * Returns true if both buffers represent the same session (same id, cwd, and header line).
 */
export function isSameSession(a: Buffer, b: Buffer): boolean {
  try {
    const idA = parseSessionIdentity(a);
    const idB = parseSessionIdentity(b);
    return idA.sessionId === idB.sessionId && idA.cwd === idB.cwd && idA.header.equals(idB.header);
  } catch {
    return false;
  }
}

function mergePlaintextLines(localText: string, remoteText: string): { merged: string; added: number } {
  const localLines = String(localText ?? '')
    .split('\n')
    .filter((line) => line.length > 0);
  const remoteLines = String(remoteText ?? '')
    .split('\n')
    .filter((line) => line.length > 0);

  const seen = new Set<string>(localLines);
  const mergedArr = [...localLines];
  let added = 0;

  for (const line of remoteLines) {
    if (!seen.has(line)) {
      seen.add(line);
      mergedArr.push(line);
      added++;
    }
  }

  const merged = mergedArr.length > 0 ? mergedArr.join('\n') + '\n' : '';
  return { merged, added };
}

/**
 * Merge two valid session buffers via binary path and return merged Buffer with added count.
 * - Validates both buffers via validated Zstd artifact API (checksum, header frame).
 * - Preserves DSH standalone checksummed Zstd header frame (first frame is header alone).
 * - Never converts Zstd bytes to UTF-8 string; only decompressed plaintext is stringified for line union.
 * - Throws if headers differ (conflict) or either buffer is invalid/truncated.
 */
export function mergeSessionBuffers(local: Buffer, remote: Buffer): { merged: Buffer; added: number } {
  const localId = parseSessionIdentity(local);
  const remoteId = parseSessionIdentity(remote);

  if (localId.sessionId !== remoteId.sessionId || localId.cwd !== remoteId.cwd || !localId.header.equals(remoteId.header)) {
    throw new Error('cannot merge session buffers with different headers');
  }

  const localFrames = scanZstdFrames(local);
  const remoteFrames = scanZstdFrames(remote);

  const localPlainBufs: Buffer[] = [];
  for (const f of localFrames) {
    try {
      localPlainBufs.push(zstdDecompressSync(local.subarray(f.start, f.end)));
    } catch (e: any) {
      throw new Error(`local session decompress failed: ${e?.message ?? String(e)}`);
    }
  }
  const remotePlainBufs: Buffer[] = [];
  for (const f of remoteFrames) {
    try {
      remotePlainBufs.push(zstdDecompressSync(remote.subarray(f.start, f.end)));
    } catch (e: any) {
      throw new Error(`remote session decompress failed: ${e?.message ?? String(e)}`);
    }
  }

  const localText = Buffer.concat(localPlainBufs).toString('utf8');
  const remoteText = Buffer.concat(remotePlainBufs).toString('utf8');

  const { merged, added } = mergePlaintextLines(localText, remoteText);

  if (added === 0) {
    return { merged: local, added: 0 };
  }

  const headerLine = localId.header.toString('utf8');
  if (!merged.startsWith(headerLine + '\n')) {
    throw new Error('merged session artifact lost its header');
  }

  const body = merged.slice(headerLine.length + 1);
  const frames: Buffer[] = [zstdCompressSync(headerLine + '\n', ZSTD_CHECKSUM_OPTIONS as any)];
  if (body.length > 0) {
    frames.push(zstdCompressSync(body, ZSTD_CHECKSUM_OPTIONS as any));
  }
  const mergedBuf = Buffer.concat(frames);
  return { merged: mergedBuf, added };
}
