/**
 * Session Zstandard line union. DSH session artifacts require the first
 * checksummed Zstandard frame to contain exactly their JSONL header line.
 * Binary-safe: .jsonl.zstd is staged and merged only through validated Zstd artifact API.
 * Zstd bytes remain Buffer and are never converted to UTF-8 string; only decompressed
 * plaintext is stringified for line union. The standalone checksummed header frame is preserved.
 */
import { copyFile, open, readFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { constants, zstdCompress, zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';

const ZSTD_MAGIC = 0xFD2FB528;
const compressZstd = promisify(zstdCompress);
const decompressZstd = promisify(zstdDecompress);
const ZSTD_CHECKSUM_OPTIONS = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
};

interface ZstdFrameRange {
  start: number;
  end: number;
}

interface SessionArtifact {
  header: string;
  text: string;
}

/**
 * Union JSONL lines (or any line-delimited text) by exact line equality.
 * Preserves local order then appends remote-only lines.
 * Ensures trailing newline when result is non-empty.
 */
export function mergeZstdLines(
  localText: string,
  remoteText: string,
): { merged: string; added: number } {
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

/** Locate complete normal Zstandard frames in a concatenated DSH artifact. */
function scanZstdFrames(source: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < source.length) {
    const start = offset;
    if (source.length - offset < 5 || source.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('corrupt Zstandard session artifact');
    }
    offset += 4;
    const descriptor = source.readUInt8(offset++);
    if ((descriptor & 0x18) !== 0) throw new Error('corrupt Zstandard frame descriptor');

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
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

function parseSessionHeader(header: Buffer, label: string): string {
  if (header.length === 0 || header.indexOf(0x0A) !== header.length - 1) {
    throw new Error(`${label} session artifact has no standalone header frame`);
  }

  const line = header.subarray(0, -1).toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`${label} session artifact has an invalid session header`);
  }

  const record = value as Record<string, unknown> | null;
  const hasValidInteger = (field: 'createdAt' | 'delegationDepth') => {
    const value = record?.[field];
    return typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= 0
      && !Object.is(value, -0);
  };
  if (
    record === null
    || typeof record !== 'object'
    || record.type !== 'session'
    || typeof record.version !== 'number'
    || typeof record.id !== 'string'
    || !hasValidInteger('createdAt')
    || !hasValidInteger('delegationDepth')
    || (record.origin !== undefined && record.origin !== 'subagent')
    || (record.agentPreset !== undefined && typeof record.agentPreset !== 'string')
  ) {
    throw new Error(`${label} session artifact has an invalid session header`);
  }
  return line;
}

async function readSessionArtifact(filePath: string, label: string): Promise<SessionArtifact> {
  if (!existsSync(filePath)) throw new Error(`${label} session artifact does not exist`);

  const source = await readFile(filePath);
  const frames = scanZstdFrames(source);
  if (frames.length === 0) throw new Error(`${label} session artifact has no Zstandard frames`);

  const headerBytes = await decompressZstd(source.subarray(frames[0]!.start, frames[0]!.end));
  const header = parseSessionHeader(headerBytes, label);
  const plaintext = await Promise.all(
    frames.map(async ({ start, end }) => decompressZstd(source.subarray(start, end))),
  );
  return { header, text: Buffer.concat(plaintext).toString('utf8') };
}

async function writeAtomically(filePath: string, content: Buffer): Promise<void> {
  const temporaryPath = `${filePath}.${randomBytes(12).toString('hex')}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  const directory = await open(dirname(filePath), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Merge two valid DSH Zstandard session artifacts into the local artifact.
 * The original local bytes are copied to a timestamped backup before the
 * atomic publish. Invalid, missing, plaintext, or mismatched input never
 * replaces the local file.
 */
export async function mergeZstdFiles(
  localPath: string,
  remotePath: string,
): Promise<{ added: number }> {
  const local = await readSessionArtifact(localPath, 'local');
  const remote = await readSessionArtifact(remotePath, 'remote');
  if (local.header !== remote.header) {
    throw new Error('cannot merge session artifacts with different headers');
  }

  const { merged, added } = mergeZstdLines(local.text, remote.text);
  if (added === 0) return { added: 0 };
  if (!merged.startsWith(local.header + '\n')) {
    throw new Error('merged session artifact lost its header');
  }

  const body = merged.slice(local.header.length + 1);
  const frames = [await compressZstd(local.header + '\n', ZSTD_CHECKSUM_OPTIONS)];
  if (body.length > 0) frames.push(await compressZstd(body, ZSTD_CHECKSUM_OPTIONS));
  const backupPath = `${localPath}.bak.${Date.now()}.${randomBytes(6).toString('hex')}`;
  await copyFile(localPath, backupPath);
  await writeAtomically(localPath, Buffer.concat(frames));

  return { added };
}
