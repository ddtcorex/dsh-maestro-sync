// src/host/s3-object-store.ts — dependency-free S3 object store client
// (SigV4 + global fetch) for Cloudflare R2 / AWS S3 backup (spec §5.2).
//
// Path-style URLs ({endpoint}/{bucket}/{key}) work for R2, AWS (with
// forcePathStyle) and the hermetic fake. ETag is a CAS token, stripped of the
// wrapping quotes S3 returns; content integrity lives in SHA-256 (blob keys +
// manifest metadata), never in the ETag (multipart/encryption break it).
import * as fsMod from 'node:fs';
import * as path from 'node:path';
import { sha256Hex, signRequest } from './sigv4.js';

export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  timeoutMs?: number;
}

export interface S3ListEntry {
  key: string;
  size: number;
  lastModified: string;
}

export interface S3HeadResult {
  size: number;
  etag: string; // quotes stripped — a CAS token, not a content checksum
}

const EMPTY_SHA = sha256Hex('');

export class S3ObjectStore {
  constructor(private readonly cfg: S3Config, private readonly f: typeof fetch = fetch) {}

  private async request(
    method: string,
    bucket: string,
    key: string,
    opts: { query?: string; body?: Buffer; etag?: string; ifNoneMatch?: boolean } = {},
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const url = `${this.cfg.endpoint}/${bucket}${key ? '/' + key : ''}${opts.query ? '?' + opts.query : ''}`;
    const host = new URL(this.cfg.endpoint).host;
    const bodySha = opts.body ? sha256Hex(opts.body) : EMPTY_SHA;
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (opts.body) headers['Content-Length'] = String(opts.body.length);
    if (opts.etag) headers['If-Match'] = opts.etag;
    if (opts.ifNoneMatch) headers['If-None-Match'] = '*';
    const signed = signRequest({
      method, host, path: `/${bucket}${key ? '/' + key : ''}`, query: opts.query,
      headers, bodySha256: bodySha,
      region: this.cfg.region, service: 's3',
      accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey,
      now: new Date(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30_000);
    try {
      const res = await this.f(url, {
        method,
        headers: { ...headers, Authorization: signed.authorization, 'X-Amz-Date': signed.amzDate, 'X-Amz-Content-Sha256': signed.xAmzContentSha256 },
        // Buffer satisfies BodyInit at runtime (undici accepts it); the TS overloads
        // only admit Blob/string/URLSearchParams/ArrayBuffer — cast is intentional.
        body: (opts.body as unknown as BodyInit) ?? undefined,
        signal: controller.signal,
      });
      if (res.status === 412) {
        return { status: 412, headers: {}, body: Buffer.alloc(0) };
      }
      if (res.status === 404 && method !== 'DELETE') {
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      }
      if (res.status < 200 || res.status > 299) {
        throw Object.assign(new Error(`S3 ${method} ${key} failed: ${res.status}`), { phase: 'backup', code: 'S3_ERROR' });
      }
      const body = Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()) as Record<string, string>, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async list(bucket: string, prefix: string): Promise<S3ListEntry[]> {
    const out: S3ListEntry[] = [];
    let token: string | undefined;
    for (;;) {
      const q = `list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
      const r = await this.request('GET', bucket, '', { query: q });
      const xml = r.body.toString('utf-8');
      const keys = [...xml.matchAll(/<Contents><Key>([^<]+)<\/Key><Size>(\d+)<\/Size><LastModified>([^<]+)<\/LastModified>/g)];
      for (const m of keys) out.push({ key: m[1]!, size: Number(m[2]!), lastModified: m[3]! });
      if (!xml.includes('<IsTruncated>true</IsTruncated>')) break;
      const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
      if (!next) break;
      token = next;
    }
    return out;
  }

  async head(bucket: string, key: string): Promise<S3HeadResult | null> {
    const r = await this.request('HEAD', bucket, key);
    if (r.status === 404) return null;
    const etag = (r.headers['etag'] ?? '""').replace(/"/g, '');
    return { size: Number(r.headers['content-length'] ?? 0), etag };
  }

  async get(bucket: string, key: string, destDir: string): Promise<S3HeadResult> {
    const r = await this.request('GET', bucket, key);
    const full = path.join(destDir, key);
    fsMod.mkdirSync(path.dirname(full), { recursive: true });
    fsMod.writeFileSync(full, r.body);
    return { size: r.body.length, etag: (r.headers['etag'] ?? '""').replace(/"/g, '') };
  }

  /**
   * If-None-Match:* put — idempotent blob semantics: a 412 (already present)
   * is a silent no-op because blobs are content-addressed (same key ⇒ same
   * bytes), so a retry never corrupts.
   */
  async putIfAbsent(bucket: string, key: string, body: Buffer): Promise<void> {
    const r = await this.request('PUT', bucket, key, { body, ifNoneMatch: true });
    if (r.status === 412) return;
  }

  /** CAS put: If-Match (or If-None-Match when the object must be absent); a 412 ⇒ CONCURRENT_MODIFICATION. */
  async putConditional(bucket: string, key: string, body: Buffer, opts: { ifMatch?: string; ifNoneMatch?: boolean } = {}): Promise<void> {
    const r = await this.request('PUT', bucket, key, { body, etag: opts.ifMatch, ifNoneMatch: opts.ifNoneMatch });
    if (r.status === 412) {
      throw Object.assign(new Error(`CONCURRENT_MODIFICATION: ${key}`), { phase: 'backup', code: 'CONCURRENT_MODIFICATION', detail: key });
    }
  }

  /** Batched DeleteObjects (≤1000 keys per request). */
  async deleteKeys(bucket: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const xml = `<?xml version="1.0"?><Delete>${batch
        .map((k) => `<Object><Key>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Key></Object>`)
        .join('')}<Quiet>false</Quiet></Delete>`;
      const r = await this.request('POST', bucket, '', { query: 'delete', body: Buffer.from(xml) });
      if (r.status !== 200) throw Object.assign(new Error(`DeleteObjects failed: ${r.status}`), { phase: 'gc', code: 'S3_ERROR' });
    }
  }
}