import { describe, it, expect } from 'vitest';
import { constants, zstdCompressSync } from 'node:zlib';
import { parseSessionIdentity, isSameSession, mergeSessionBuffers } from '../src/host/session-plan.js';

function makeSessionBuffer(header: string, events: string[]): Buffer {
  const opts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } } as any;
  const frames: Buffer[] = [zstdCompressSync(header + '\n', opts)];
  if (events.length > 0) {
    frames.push(zstdCompressSync(events.join('\n') + '\n', opts));
  }
  return Buffer.concat(frames);
}

describe('session-plan', () => {
  it('rejects truncated Zstd frame as conflict', async () => {
    expect(() => parseSessionIdentity(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))).toThrow()
  })

  it('merges two valid session buffers via binary path and counts added lines', async () => {
    const header = JSON.stringify({ type: 'session', version: 1, id: 'sync-test', createdAt: 1, delegationDepth: 0, cwd: '/tmp/proj' });
    const localBuf = makeSessionBuffer(header, ['{"type":"turn/start","seq":0}']);
    const remoteBuf = makeSessionBuffer(header, ['{"type":"turn/start","seq":0}', '{"type":"turn/end","seq":1}']);
    const { merged, added } = mergeSessionBuffers(localBuf, remoteBuf)
    expect(added).toBe(1)
    expect(isSameSession(localBuf, remoteBuf)).toBe(true)
    expect(Buffer.isBuffer(merged)).toBe(true)
    // merged should be valid Zstd and isSameSession with originals
    expect(isSameSession(merged, localBuf)).toBe(true)
  })

  it('rejects invalid Zstd in merge and different headers as conflict', () => {
    const bad = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const header = JSON.stringify({ type: 'session', version: 1, id: 'id1', createdAt: 1, delegationDepth: 0 });
    const good = makeSessionBuffer(header, ['{"seq":1}']);
    expect(() => mergeSessionBuffers(bad, good)).toThrow();
    expect(() => mergeSessionBuffers(good, bad)).toThrow();
    const header2 = JSON.stringify({ type: 'session', version: 1, id: 'different-id', createdAt: 1, delegationDepth: 0 });
    const other = makeSessionBuffer(header2, ['{"seq":1}']);
    expect(isSameSession(good, other)).toBe(false);
    expect(() => mergeSessionBuffers(good, other)).toThrow();
  })

  it('isSameSession compares header identity, not just path', () => {
    const h1 = JSON.stringify({ type: 'session', version: 1, id: 'same-id', createdAt: 1, delegationDepth: 0, cwd: '/a' });
    const h2 = JSON.stringify({ type: 'session', version: 1, id: 'same-id', createdAt: 1, delegationDepth: 0, cwd: '/b' });
    const buf1 = makeSessionBuffer(h1, ['a']);
    const buf2 = makeSessionBuffer(h2, ['a']);
    expect(isSameSession(buf1, buf2)).toBe(false);
  })
})
