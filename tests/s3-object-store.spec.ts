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

describe('S3ObjectStore put/delete', () => {
  it('putIfAbsent is idempotent: a second put with the same key is a no-op (blob semantics)', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const store = new S3ObjectStore(cfg(h.url));
    await store.putIfAbsent(h.bucket, 'blobs/sha256/aa', Buffer.from('v1'));
    await store.putIfAbsent(h.bucket, 'blobs/sha256/aa', Buffer.from('v1'));
    expect(h.objects().get('blobs/sha256/aa')!.toString('utf-8')).toBe('v1');
  });

  it('putConditional with a wrong ifMatch throws CONCURRENT_MODIFICATION and does not overwrite', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const store = new S3ObjectStore(cfg(h.url));
    await store.putConditional(h.bucket, 'HEAD', Buffer.from('m1'));
    const head = await store.head(h.bucket, 'HEAD');
    await expect(store.putConditional(h.bucket, 'HEAD', Buffer.from('m2'), { ifMatch: 'wrong-etag' })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    expect((await store.head(h.bucket, 'HEAD'))!.etag).toBe(head!.etag);
  });

  it('putConditional with ifNoneMatch on an existing key throws CONCURRENT_MODIFICATION', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const store = new S3ObjectStore(cfg(h.url));
    await store.putIfAbsent(h.bucket, 'HEAD', Buffer.from('m1'));
    await expect(store.putConditional(h.bucket, 'HEAD', Buffer.from('m2'), { ifNoneMatch: true })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
  });

  it('deleteKeys deletes exactly the given keys', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const store = new S3ObjectStore(cfg(h.url));
    for (const k of ['a', 'b', 'c']) await store.putIfAbsent(h.bucket, k, Buffer.from('x'));
    await store.deleteKeys(h.bucket, ['a', 'c']);
    expect(h.objects().has('a')).toBe(false);
    expect(h.objects().has('c')).toBe(false);
    expect(h.objects().has('b')).toBe(true);
  });
});