// tests/s3-object-store.spec.ts — S3ObjectStore against the hermetic fake S3.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startFakeS3 } from './helpers/fake-s3.js';
import { S3ObjectStore, type S3Config } from '../src/host/s3-object-store.js';

const handles: Awaited<ReturnType<typeof startFakeS3>>[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.close();
});

function cfg(url: string): S3Config {
  return { endpoint: url, region: 'auto', accessKeyId: 'ak', secretAccessKey: 'sk' };
}

async function putViaFetch(h: Awaited<ReturnType<typeof startFakeS3>>, key: string, body: string) {
  await fetch(`${h.url}/${h.bucket}/${key}`, { method: 'PUT', body: Buffer.from(body) });
}

describe('S3ObjectStore list/head/get', () => {
  it('lists with pagination and reports keys+size', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const store = new S3ObjectStore(cfg(h.url));
    for (let i = 0; i < 5; i++) await putViaFetch(h, `blobs/${i}`, `v${i}`);
    const all = await store.list(h.bucket, 'blobs/');
    expect(all.map((e) => e.key).sort()).toEqual(['blobs/0', 'blobs/1', 'blobs/2', 'blobs/3', 'blobs/4']);
    expect(all[0]!.size).toBe(2);
  });

  it('head returns null when missing and etag+size when present', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const store = new S3ObjectStore(cfg(h.url));
    await putViaFetch(h, 'a', 'hi');
    expect(await store.head(h.bucket, 'a')).toMatchObject({ size: 2 });
    expect(await store.head(h.bucket, 'absent')).toBeNull();
  });

  it('get downloads to destDir/<key> byte-exact', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const store = new S3ObjectStore(cfg(h.url));
    await putViaFetch(h, 'blobs/x', 'download-me');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 's3get-'));
    try {
      const head = await store.get(h.bucket, 'blobs/x', dest);
      expect(fs.readFileSync(path.join(dest, 'blobs', 'x'), 'utf-8')).toBe('download-me');
      expect(head.size).toBe(11);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});