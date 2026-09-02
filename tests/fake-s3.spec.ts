// tests/fake-s3.spec.ts — smoke tests pinning the hermetic fake S3 contract.
import { describe, it, expect, afterEach } from 'vitest';
import { startFakeS3 } from './helpers/fake-s3.js';

const handles: Awaited<ReturnType<typeof startFakeS3>>[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.close();
});

async function req(method: string, url: string, headers: Record<string, string> = {}, body?: Buffer) {
  const res = await fetch(url, { method, headers: { ...headers }, body });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()) as Record<string, string>, body: Buffer.from(await res.arrayBuffer()) };
}

describe('fake s3', () => {
  it('put / head / get round-trip with an md5 etag', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const key = `${h.bucket}/blobs/sha256/abc`;
    const put = await req('PUT', `${h.url}/${key}`, { 'If-None-Match': '*' }, Buffer.from('hello'));
    expect(put.status).toBe(200);
    expect((put.headers['etag'] ?? '').length).toBeGreaterThan(2);
    const head = await req('HEAD', `${h.url}/${key}`);
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('5');
    const get = await req('GET', `${h.url}/${key}`);
    expect(get.body.toString('utf-8')).toBe('hello');
  });

  it('If-None-Match: * on an existing key returns 412', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const key = `${h.bucket}/k`;
    await req('PUT', `${h.url}/${key}`, {}, Buffer.from('x'));
    const dup = await req('PUT', `${h.url}/${key}`, { 'If-None-Match': '*' }, Buffer.from('y'));
    expect(dup.status).toBe(412);
    // If-Match with the right etag passes; wrong etag is 412
    const head = await req('HEAD', `${h.url}/${key}`);
    const okPut = await req('PUT', `${h.url}/${key}`, { 'If-Match': head.headers['etag'] }, Buffer.from('z'));
    expect(okPut.status).toBe(200);
    const badPut = await req('PUT', `${h.url}/${key}`, { 'If-Match': '"wrong"' }, Buffer.from('w'));
    expect(badPut.status).toBe(412);
  });

  it('ListObjectsV2 paginates with continuation tokens', async () => {
    const h = await startFakeS3();
    handles.push(h);
    for (let i = 0; i < 5; i++) await req('PUT', `${h.url}/${h.bucket}/blobs/sha256/${i}`);
    const page1 = await req('GET', `${h.url}/${h.bucket}?list-type=2&prefix=blobs/&max-keys=2`);
    const xml1 = page1.body.toString('utf-8');
    expect(xml1).toContain('<Key>blobs/sha256/0</Key>');
    expect(xml1).toContain('<IsTruncated>true</IsTruncated>');
    const token = xml1.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]!;
    const page2 = await req('GET', `${h.url}/${h.bucket}?list-type=2&prefix=blobs/&max-keys=2&continuation-token=${encodeURIComponent(token)}`);
    const xml2 = page2.body.toString('utf-8');
    expect(xml2).toContain('<Key>blobs/sha256/2</Key>');
    expect(xml2).toContain('<IsTruncated>true</IsTruncated>');
  });

  it('DeleteObjects deletes exactly the given keys', async () => {
    const h = await startFakeS3();
    handles.push(h);
    for (const k of ['a', 'b', 'c']) await req('PUT', `${h.url}/${h.bucket}/${k}`);
    const body = `<?xml version="1.0"?><Delete><Object><Key>a</Key></Object><Object><Key>c</Key></Object></Delete>`;
    const del = await req('POST', `${h.url}/${h.bucket}?delete`, { 'Content-Type': 'application/xml' }, Buffer.from(body));
    expect(del.status).toBe(200);
    expect(h.objects().has('a')).toBe(false);
    expect(h.objects().has('c')).toBe(false);
    expect(h.objects().has('b')).toBe(true);
  });
});