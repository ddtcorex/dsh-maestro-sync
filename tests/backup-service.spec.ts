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
});