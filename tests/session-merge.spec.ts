import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompress, zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { mergeZstdFiles, mergeZstdLines } from '../src/host/session-merge.js';

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

function zstdFrames(source: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;

  while (offset < source.length) {
    const start = offset;
    expect(source.readUInt32LE(offset)).toBe(0xFD2FB528);
    offset += 4;
    const descriptor = source.readUInt8(offset++);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    offset += (singleSegment ? 0 : 1)
      + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag);

    for (;;) {
      const blockHeader = source.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      offset += blockType === 1 ? 1 : blockHeader >>> 3;
      if (lastBlock) break;
    }
    if ((descriptor & 0x04) !== 0) offset += 4;
    frames.push(source.subarray(start, offset));
  }

  return frames;
}

async function zstdSession(header: string, events: string[]): Promise<Buffer> {
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  return Buffer.concat([
    await compress(header + '\n', options),
    await compress(events.join('\n') + '\n', options),
  ]);
}

describe('mergeZstdLines', () => {
  it('unions jsonl lines', () => {
    const a = '{"seq":1}\n{"seq":2}\n';
    const b = '{"seq":2}\n{"seq":3}\n';
    const { merged, added } = mergeZstdLines(a, b);
    expect(added).toBe(1);
    expect(merged.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('idempotent', () => {
    const a = 'x\ny\n';
    const b = 'y\nz\n';
    const { merged: ab } = mergeZstdLines(a, b);
    const { added } = mergeZstdLines(ab, b);
    expect(added).toBe(0);
  });

  it('writes the session header as the exact first zstd frame when merging files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-maestro-sync-'));
    const localPath = join(directory, 'local.jsonl.zstd');
    const remotePath = join(directory, 'remote.jsonl.zstd');
    const header = '{"type":"session","version":1,"id":"sync-test","createdAt":1,"delegationDepth":0}';

    try {
      await writeFile(localPath, await zstdSession(header, ['{"type":"turn/start","seq":0}']));
      await writeFile(remotePath, await zstdSession(header, ['{"type":"turn/end","seq":1}']));

      await expect(mergeZstdFiles(localPath, remotePath)).resolves.toEqual({ added: 1 });

      const frames = zstdFrames(await readFile(localPath));
      expect(frames.length).toBeGreaterThan(1);
      await expect(decompress(frames[0]!)).resolves.toEqual(Buffer.from(header + '\n'));
      expect((await decompress(Buffer.concat(frames.slice(1)))).toString('utf8'))
        .toContain('"type":"turn/end"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not replace the local artifact when a source has no valid session header', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-maestro-sync-'));
    const localPath = join(directory, 'local.jsonl.zstd');
    const remotePath = join(directory, 'remote.jsonl.zstd');
    const header = '{"type":"session","version":1,"id":"sync-test","createdAt":1,"delegationDepth":0}';

    try {
      await writeFile(localPath, await zstdSession(header, ['{"type":"turn/start","seq":0}']));
      const before = await readFile(localPath);
      await writeFile(remotePath, await compress('{"type":"turn/end","seq":1}\n'));

      await expect(mergeZstdFiles(localPath, remotePath)).rejects.toThrow(/invalid session header/);
      await expect(readFile(localPath)).resolves.toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
