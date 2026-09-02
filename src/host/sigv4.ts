// src/host/sigv4.ts — AWS Signature Version 4 (S3 service) with zero deps.
//
// Computes the canonical request, the string-to-sign, and the signing key
// chain exactly per the AWS docs; the pinned known-answer test keeps it honest.
// ETag is a CAS/version token, never a content checksum — our content
// integrity lives in SHA-256 (blob keys + manifest metadata).
import { createHash, createHmac } from 'node:crypto';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function isoDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // YYYYMMDDTHHMMSSZ
}

function scopeDate(d: Date): string {
  return isoDate(d).slice(0, 8);
}

export interface SignRequestOpts {
  method: string;
  host: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  bodySha256: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

export interface SignedRequest {
  authorization: string;
  amzDate: string;
  xAmzContentSha256: string;
}

export function signRequest(opts: SignRequestOpts): SignedRequest {
  const amzDate = isoDate(opts.now);
  const date = scopeDate(opts.now);
  const raw: Record<string, string> = {
    host: opts.host,
    'x-amz-content-sha256': opts.bodySha256,
    'x-amz-date': amzDate,
    ...opts.headers,
  };
  // Signed headers are lower-cased; look up through a normalized map so mixed
  // case (e.g. 'Content-Length') never hits an undefined value.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = v;
  const signedKeys = Object.keys(headers).sort();
  const canonicalHeaders = signedKeys.map((k) => `${k}:${headers[k]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonicalQuery = (opts.query ?? '').split('&').filter(Boolean).sort().join('&');
  const canonicalRequest = [
    opts.method.toUpperCase(),
    opts.path,
    canonicalQuery,
    canonicalHeaders,
    signedKeys.join(';'),
    opts.bodySha256,
  ].join('\n');
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(Buffer.from(`AWS4${opts.secretAccessKey}`, 'utf8'), date);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedKeys.join(';')}, Signature=${signature}`,
    amzDate,
    xAmzContentSha256: opts.bodySha256,
  };
}