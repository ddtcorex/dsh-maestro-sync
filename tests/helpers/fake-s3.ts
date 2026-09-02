// tests/helpers/fake-s3.ts — hermetic in-process S3 server for backup tests.
//
// Implements exactly the surface S3ObjectStore consumes (path-style URLs):
// ListObjectsV2 (pagination), HeadObject, PutObject with conditional
// If-None-Match/If-Match, GetObject, DeleteObjects. ETag = md5 hex. This is
// the Phase-3 gate — no live R2/AWS account is needed to develop backup.
import * as http from 'node:http';
import { createHash } from 'node:crypto';

export interface FakeS3Handle {
  url: string; // http://127.0.0.1:<port>
  bucket: string;
  close(): Promise<void>;
  objects(): Map<string, Buffer>;
}

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startFakeS3(bucket = 'maestro-backup'): Promise<FakeS3Handle> {
  const objects = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const segs = url.pathname.split('/').filter(Boolean); // [bucket, ...key]
    const key = segs.slice(1).join('/');
    const isBucket = segs.length === 1 && segs[0] === bucket;
    const respond = (status: number, headers: Record<string, string>, body?: Buffer) => {
      if (!res.headersSent) res.writeHead(status, headers);
      res.end(body);
    };
    try {
      if (req.method === 'PUT' && !isBucket) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const ifMatch = (req.headers['if-match'] ?? '').replace(/"/g, '');
          if (req.headers['if-none-match'] === '*' && objects.has(key)) return respond(412, {});
          if (ifMatch && objects.has(key) && md5(objects.get(key)!) !== ifMatch) return respond(412, {});
          if (ifMatch && !objects.has(key)) return respond(412, {});
          objects.set(key, body);
          respond(200, { ETag: `"${md5(body)}"` });
        });
        return;
      }
      if (req.method === 'HEAD' && !isBucket) {
        const b = objects.get(key);
        if (!b) return respond(404, {});
        return respond(200, { ETag: `"${md5(b)}"`, 'Content-Length': String(b.length) });
      }
      if (req.method === 'GET' && !isBucket) {
        const b = objects.get(key);
        if (!b) return respond(404, {});
        return respond(200, { ETag: `"${md5(b)}"` }, b);
      }
      if (req.method === 'GET' && isBucket && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const max = Number(url.searchParams.get('max-keys') ?? 1000);
        const tokenRaw = url.searchParams.get('continuation-token');
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = tokenRaw === null ? 0 : Number(tokenRaw);
        const page = all.slice(start, start + max);
        const truncated = start + page.length < all.length;
        const xml =
          '<?xml version="1.0"?><ListBucketResult><IsTruncated>' +
          truncated +
          '</IsTruncated>' +
          (truncated ? `<NextContinuationToken>${start + page.length}</NextContinuationToken>` : '') +
          page
            .map((k) => `<Contents><Key>${escXml(k)}</Key><Size>${objects.get(k)!.length}</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`)
            .join('') +
          '</ListBucketResult>';
        return respond(200, { 'Content-Type': 'application/xml' }, Buffer.from(xml));
      }
      if (req.method === 'POST' && isBucket && url.searchParams.get('delete') !== null) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const keys = [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
          for (const k of keys) objects.delete(k);
          respond(200, { 'Content-Type': 'application/xml' }, Buffer.from(`<?xml version="1.0"?><DeleteResult>${keys.map((k) => `<Deleted><Key>${escXml(k)}</Key></Deleted>`).join('')}</DeleteResult>`));
        });
        return;
      }
      respond(400, {}, Buffer.from('unsupported fake-s3 request'));
    } catch (e: any) {
      respond(500, {}, Buffer.from(String(e?.message ?? e)));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port as number;
  return {
    url: `http://127.0.0.1:${port}`,
    bucket,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    objects: () => objects,
  };
}