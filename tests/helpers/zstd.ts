/**
 * Shared Zstd session fixture helpers — byte-exact, checksummed, standalone header frame.
 * Mirrors DSH session.jsonl.zstd layout: first frame is the JSONL header line alone.
 */
import { constants, zstdCompressSync } from 'node:zlib';

export function makeSessionBuffer(header: string, events: string[]): Buffer {
  const opts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } } as any;
  const frames: Buffer[] = [zstdCompressSync(header + '\n', opts)];
  if (events.length > 0) {
    frames.push(zstdCompressSync(events.join('\n') + '\n', opts));
  }
  return Buffer.concat(frames);
}

export function sessionHeader(id = 'sync-test', cwd = '/tmp/proj'): string {
  return JSON.stringify({ type: 'session', version: 1, id, createdAt: 1, delegationDepth: 0, cwd });
}

export const ZSTD_MAGIC = 0xfd2fb528;