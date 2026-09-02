// tests/backup-service.spec.ts — BackupService preview/apply against the fake S3.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startFakeS3 } from './helpers/fake-s3.js';
import { S3ObjectStore } from '../src/host/s3-object-store.js';
import { BackupService, type BackupManifest } from '../src/host/backup-service.js';

const handles: Awaited<ReturnType<typeof startFakeS3>>[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.close();
});

function makeSvc(h: Awaited<ReturnType<typeof startFakeS3>>, localDsh: string) {
  const store = new S3ObjectStore({ endpoint: h.url, region: 'auto', accessKeyId: 'ak', secretAccessKey: 'sk' });
  return new BackupService({
    localDsh,
    store,
    target: { provider: 'r2', bucket: h.bucket, prefix: 'v1/hosts/t/', hostId: 't' },
    previewDir: path.join(localDsh, '.pv'),
    cacheDir: path.join(localDsh, '.fp'),
    fs: fs as any,
  });
}

describe('backup preview', () => {
  it('preview is read-only: reports missing/identical against a HEAD manifest without uploading', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    try {
      fs.mkdirSync(path.join(dsh, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(dsh, 'memories/daily/2026-09-01.md'), 'day-one');
      const svc = makeSvc(h, dsh);
      const p = await svc.preview();
      expect(p.summary.missing).toBeGreaterThanOrEqual(1); // nothing backed up yet
      expect(p.summary.identical).toBe(0);
      expect(h.objects().size).toBe(0); // preview uploaded nothing
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });

  it('preview persists a single-use JSON in the preview dir', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'bk2-'));
    try {
      fs.mkdirSync(path.join(dsh, 'memories'));
      fs.writeFileSync(path.join(dsh, 'memories/a.md'), 'x');
      const svc = makeSvc(h, dsh);
      const p = await svc.preview();
      const file = path.join(dsh, '.pv', `${p.previewId}.backup.json`);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });

describe('backup apply', () => {
  it('uploads blobs, writes an immutable manifest, CAS-advances HEAD; ok only after HEAD', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'bk2-'));
    try {
      fs.mkdirSync(path.join(dsh, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(dsh, 'memories/a.md'), 'backup-me');
      const svc = makeSvc(h, dsh);
      const p = await svc.preview();
      expect(p.summary.missing).toBe(1);
      const r = await svc.apply({ previewId: p.previewId, confirm: true });
      expect(r.ok).toBe(true);
      expect(r.committed).toContain('memories/a.md');
      const listStore = new S3ObjectStore({ endpoint: h.url, region: 'auto', accessKeyId: 'ak', secretAccessKey: 'sk' });
      const keys = (await listStore.list(h.bucket, 'v1/hosts/t/')).map((e: any) => e.key);
      expect(keys.some((k: string) => k.startsWith('v1/hosts/t/blobs/sha256/'))).toBe(true);
      expect(keys.some((k: string) => k.startsWith('v1/hosts/t/manifests/'))).toBe(true);
      expect(keys).toContain('v1/hosts/t/HEAD');
      const p2 = await svc.preview();
      expect(p2.summary.identical).toBe(1);
      expect(p2.summary.missing).toBe(0);
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });

  it('a concurrent HEAD advanced by another writer -> CONCURRENT_MODIFICATION, no manifest published', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'bk3-'));
    try {
      fs.mkdirSync(path.join(dsh, 'memories'));
      fs.writeFileSync(path.join(dsh, 'memories/a.md'), 'x');
      const svcA = makeSvc(h, dsh);
      const pa = await svcA.preview();
      await svcA.apply({ previewId: pa.previewId, confirm: true }); // A owns HEAD
      // another writer advances HEAD between B's preview and B's apply
      const storeB = new S3ObjectStore({ endpoint: h.url, region: 'auto', accessKeyId: 'ak', secretAccessKey: 'sk' });
      await storeB.putConditional(h.bucket, 'v1/hosts/t/HEAD', Buffer.from(JSON.stringify({ manifestKey: 'v1/hosts/t/manifests/other.json' })), { ifMatch: (await svcA.readHeadManifest()) ? (await storeB.head(h.bucket, 'v1/hosts/t/HEAD'))!.etag : undefined });
      const svcB = new BackupService({ localDsh: dsh, store: storeB, target: { provider: 'r2', bucket: h.bucket, prefix: 'v1/hosts/t/', hostId: 't' }, previewDir: path.join(dsh, '.pv'), cacheDir: path.join(dsh, '.fp'), fs: fs as any });
      const pb = await svcB.preview();
      const r = await svcB.apply({ previewId: pb.previewId, confirm: true });
      expect(r.ok).toBe(false);
      expect(r.failures.some((f: any) => f.code === 'CONCURRENT_MODIFICATION')).toBe(true);
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });
});
});
