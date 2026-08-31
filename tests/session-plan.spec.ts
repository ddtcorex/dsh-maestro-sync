import { describe, it, expect } from 'vitest';
import { zstdCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';
import { parseSessionIdentity, isSameSession, mergeSessionBuffers } from '../src/host/session-plan.js';

const compressZstd = promisify(zstdCompress);

async function makeZstd(text: string): Promise<Buffer> {
  return (await compressZstd(Buffer.from(text, 'utf-8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } } as any)) as Buffer;
}

describe('session-plan', () => {
  it('rejects truncated Zstd frame as conflict', () => {
    expect(() => parseSessionIdentity(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))).toThrow();
    expect(() => parseSessionIdentity(Buffer.from([0x00, 0x01, 0x02]))).toThrow();
    expect(() => parseSessionIdentity(Buffer.from('not zstd'))).toThrow();
  });

  it('merges two valid session buffers via binary path and counts added lines', async () => {
    const localBuf = await makeZstd('{"seq":1}\n{"seq":2}\n');
    const remoteBuf = await makeZstd('{"seq":1}\n{"seq":2}\n{"seq":3}\n');
    // isSameSession should be true for same session (header same) - our simple impl checks magic, so should be true
    // For this test, we consider same session if both have valid Zstd magic
    expect(isSameSession(localBuf, remoteBuf)).toBe(true);
    const { merged, added } = await mergeSessionBuffers(localBuf, remoteBuf);
    expect(added).toBe(1);
    expect(Buffer.isBuffer(merged)).toBe(true);
    expect(merged.length).toBeGreaterThan(10);
  });

  it('rejects invalid Zstd in merge', async () => {
    const bad = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const good = await makeZstd('{"seq":1}\n');
    await expect(mergeSessionBuffers(bad, good)).rejects.toThrow();
    await expect(mergeSessionBuffers(good, bad)).rejects.toThrow();
  });
});
