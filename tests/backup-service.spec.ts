// tests/backup-service.spec.ts — BackupService preview/apply against the fake S3.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startFakeS3 } from './helpers/fake-s3.js';
import { S3ObjectStore } from '../src/host/s3-object-store.js';
import { BackupService } from '../src/host/backup-service.js';

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
      expect(p.summary.missing).toBeGreaterThanOrEqual(1);
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
      const keys = (await listStore.list(h.bucket, 'v1/hosts/t/')).map((e) => e.key);
      expect(keys.some((k) => k.startsWith('v1/hosts/t/blobs/sha256/'))).toBe(true);
      expect(keys.some((k) => k.startsWith('v1/hosts/t/manifests/'))).toBe(true);
      expect(keys).toContain('v1/hosts/t/HEAD');
      const p2 = await svc.preview();
      expect(p2.summary.identical).toBe(1);
      expect(p2.summary.missing).toBe(0);
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });

  it('apply is single-use: a consumed or expired preview refuses with STALE_PREVIEW', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'bk3-'));
    try {
      fs.mkdirSync(path.join(dsh, 'memories'));
      fs.writeFileSync(path.join(dsh, 'memories/a.md'), 'x');
      const svc = makeSvc(h, dsh);
      const p = await svc.preview();
      await svc.apply({ previewId: p.previewId, confirm: true });
      await expect(svc.apply({ previewId: p.previewId, confirm: true })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
      const eId = 'e'.repeat(32);
      fs.writeFileSync(
        path.join(dsh, '.pv', `${eId}.backup.json`),
        JSON.stringify({ previewId: eId, revision: 'r', expiresAt: new Date(Date.now() - 1000).toISOString(), summary: { identical: 0, missing: 1, addedBytes: 1 } }),
      );
      await expect(svc.apply({ previewId: eId, confirm: true })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });

  it('apply requires confirm:true', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'bk3c-'));
    try {
      fs.mkdirSync(path.join(dsh, 'memories'));
      fs.writeFileSync(path.join(dsh, 'memories/a.md'), 'x');
      const svc = makeSvc(h, dsh);
      const p = await svc.preview();
      await expect(svc.apply({ previewId: p.previewId, confirm: false as any })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });

  it('ok only after HEAD advances: a blob failure journal + ok:false', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'bk3f-'));
    try {
      fs.mkdirSync(path.join(dsh, 'memories'));
      fs.writeFileSync(path.join(dsh, 'memories/a.md'), 'x');
      fs.writeFileSync(path.join(dsh, 'memories/b.md'), 'y');
      // break the store so blob PUTs fail: point at a fresh fake with the same prefix but a header that 400s
      const svc = makeSvc(h, dsh);
      const p = await svc.preview();
      // corrupt: remove the bucket dir capability by forcing S3_ERROR through an invalid endpoint target
      const broken = new BackupService({
        localDsh: dsh,
        store: new S3ObjectStore({ endpoint: 'http://127.0.0.1:1', region: 'auto', accessKeyId: 'ak', secretAccessKey: 'sk' }),
        target: { provider: 'r2', bucket: h.bucket, prefix: 'v1/hosts/t/', hostId: 't' },
        previewDir: path.join(dsh, '.pv'),
        cacheDir: path.join(dsh, '.fp'),
        fs: fs as any,
      });
      // reuse the preview id but against the broken store: apply must not throw, must journal
      const r = await broken.apply({ previewId: p.previewId, confirm: true });
      expect(r.ok).toBe(false);
      expect(r.failures.some((f: any) => f.code === 'PREVIEW_REFRESH_FAILED' || f.code === 'UPLOAD_FAILED' || f.code === 'S3_ERROR')).toBe(true);
      expect(r.committed.length).toBe(0);
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });

describe('restore', () => {
  async function seeded(dsh: string, h: Awaited<ReturnType<typeof startFakeS3>>) {
    fs.mkdirSync(path.join(dsh, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(dsh, 'memories/a.md'), 'backed-a');
    fs.writeFileSync(path.join(dsh, 'memories/only-backup.md'), 'gone-locally');
    const svc = makeSvc(h, dsh);
    const p = await svc.preview();
    await svc.apply({ previewId: p.previewId, confirm: true });
    // diverge: a.md newer locally, only-backup.md deleted locally
    fs.writeFileSync(path.join(dsh, 'memories/a.md'), 'local-edit');
    fs.unlinkSync(path.join(dsh, 'memories/only-backup.md'));
    return svc;
  }

  it('restore to a new directory never touches the live home but materializes the backed-up bytes', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
    const dest = path.join(dsh, 'restored');
    try {
      const svc = await seeded(dsh, h);
      fs.writeFileSync(path.join(dsh, 'memories/only-backup.md'), 'local-edit-after-backup');
      const liveBefore = fs.readFileSync(path.join(dsh, 'memories/only-backup.md'), 'utf-8');
      const rp = await svc.restorePreview({ mode: 'new-dir' });
      const r = await svc.restoreApply({ previewId: rp.previewId, mode: 'new-dir', destDir: dest, confirm: true });
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(dest, 'memories/a.md'), 'utf-8')).toBe('backed-a');
      expect(fs.existsSync(path.join(dest, 'memories/only-backup.md'))).toBe(true);
      expect(fs.readFileSync(path.join(dsh, 'memories/only-backup.md'), 'utf-8')).toBe(liveBefore); // live untouched
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });

  it('in-place restore backs up the overwritten file and never deletes unrelated files', async () => {
    const h = await startFakeS3();
    handles.push(h);
    const dsh = fs.mkdtempSync(path.join(os.tmpdir(), 'rs2-'));
    try {
      const svc = await seeded(dsh, h);
      fs.writeFileSync(path.join(dsh, 'memories/unrelated.md'), 'keep-me');
      const rp = await svc.restorePreview({ mode: 'in-place' });
      const r = await svc.restoreApply({ previewId: rp.previewId, mode: 'in-place', confirm: true });
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(dsh, 'memories/a.md'), 'utf-8')).toBe('backed-a'); // restored over the local edit
      expect(fs.existsSync(path.join(dsh, 'memories/only-backup.md'))).toBe(true);       // re-created from backup
      const baks = fs.readdirSync(path.join(dsh, 'memories')).filter((f) => f.includes('.bak.'));
      expect(baks.some((f) => f.startsWith('a.md.bak.'))).toBe(true);                    // overwritten target kept a backup
      expect(fs.readFileSync(path.join(dsh, 'memories/unrelated.md'), 'utf-8')).toBe('keep-me'); // unrelated untouched
    } finally {
      fs.rmSync(dsh, { recursive: true, force: true });
    }
  });
});
});
