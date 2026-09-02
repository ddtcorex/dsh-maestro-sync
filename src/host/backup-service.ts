// src/host/backup-service.ts — R2/S3 backup engine (spec §5.4–§5.6, decision C).
//
// Layout: blobs/sha256/<sha> (immutable, content-addressed) + manifests/<ts>-<id>
// (immutable snapshot) + HEAD (CAS pointer). preview() is READ-ONLY: it compares
// the current eligible local hashes against the HEAD manifest (no object
// download, no upload). apply() is the only bucket-mutation route: PUT missing
// blobs (idempotent by sha) → PUT a fresh immutable manifest → CAS-advance HEAD.
// Restore and GC arrive in later tasks of the same module.
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { normalizeEligiblePath } from './validation.js';
import { hashFiles } from './hashing.js';
import { loadIndex, saveIndex, probeIndex, matchesStat, statFingerprint } from './fingerprint.js';
import type { S3ObjectStore } from './s3-object-store.js';
import type { BackupTarget } from './backup-config.js';

export interface BackupManifestFile {
  path: string;
  sha256: string;
  size: number;
  blobKey: string;
}

export interface BackupManifest {
  schema: 1;
  hostId: string;
  createdAt: string;
  files: BackupManifestFile[];
}

export interface BackupPreview {
  previewId: string;
  revision: string;
  expiresAt: string;
  summary: { identical: number; missing: number; addedBytes: number };
}

export interface BackupApplyResult {
  ok: boolean;
  revision: string;
  committed: string[];
  failures: SyncFailureLike[];
}

// Minimal failure shape (mirrors SyncFailure without importing the sync module graph).
export interface SyncFailureLike {
  phase: string;
  code: string;
  detail: string;
  path?: string;
}

const TTL_MS = 60_000;

export class BackupService {
  constructor(private readonly opts: { localDsh: string; store: S3ObjectStore; target: BackupTarget; previewDir: string; cacheDir: string; fs?: any }) {}

  blobKey(sha: string): string {
    return `blobs/sha256/${sha}`;
  }

  listEligibleFiles(): string[] {
    const root = this.opts.localDsh;
    const fsMod = this.opts.fs ?? nodeFs;
    const out: string[] = [];
    const walk = (dir: string) => {
      let ents: any[];
      try {
        ents = fsMod.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        const full = path.join(dir, ent.name);
        if (typeof ent.isDirectory === 'function' && ent.isDirectory()) {
          if (!['node_modules', '.git', '.supervisor', 'profiles'].includes(ent.name)) walk(full);
        } else {
          const rel = full.slice(root.length + 1).split(path.sep).join('/');
          try {
            normalizeEligiblePath(rel);
            out.push(rel);
          } catch {}
        }
      }
    };
    try {
      walk(path.join(root, 'memories'));
      walk(path.join(root, 'sessions'));
    } catch {}
    return out.sort();
  }

  async readHeadManifest(): Promise<{ key: string; manifest: BackupManifest } | null> {
    const headKey = `${this.opts.target.prefix}HEAD`;
    const head = await this.opts.store.head(this.opts.target.bucket, headKey);
    if (!head) return null;
    const tmp = path.join(require('node:os').tmpdir(), `bk-head-${randomBytes(4).toString('hex')}`);
    nodeFs.mkdirSync(tmp, { recursive: true });
    try {
      await this.opts.store.get(this.opts.target.bucket, headKey, tmp);
      const headBody = JSON.parse(nodeFs.readFileSync(path.join(tmp, headKey), 'utf-8')) as { manifestKey: string };
      await this.opts.store.get(this.opts.target.bucket, headBody.manifestKey, tmp);
      const manifest = JSON.parse(nodeFs.readFileSync(path.join(tmp, headBody.manifestKey), 'utf-8')) as BackupManifest;
      return { key: headBody.manifestKey, manifest };
    } finally {
      try {
        nodeFs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }

  private async localHashes(): Promise<{ path: string; sha256: string; size: number }[]> {
    const fsMod = this.opts.fs ?? nodeFs;
    const paths = this.listEligibleFiles();
    const index = loadIndex(this.opts.cacheDir);
    const stale: string[] = [];
    const local: { path: string; sha256: string; size: number }[] = [];
    for (const rel of paths) {
      const full = path.join(this.opts.localDsh, rel);
      try {
        const st = fsMod.statSync(full, { bigint: true } as any);
        const e = probeIndex(rel, index);
        if (e && matchesStat(e, st)) local.push({ path: rel, sha256: e.sha256, size: e.size });
        else stale.push(rel);
      } catch {
        stale.push(rel);
      }
    }
    const hashed = await hashFiles(fsMod, this.opts.localDsh, stale);
    for (const f of hashed) {
      local.push({ path: f.path, sha256: f.sha256, size: f.size });
      try {
        const st = fsMod.statSync(path.join(this.opts.localDsh, f.path), { bigint: true } as any);
        index.entries[f.path] = { ...statFingerprint(st), sha256: f.sha256 };
      } catch {}
    }
    if (hashed.length > 0) saveIndex(this.opts.cacheDir, index);
    return local.sort((a, b) => a.path.localeCompare(b.path));
  }

  async preview(fileList?: { path: string; sha256: string; size: number }[]): Promise<BackupPreview> {
    // fileList override exists for tests; production uses the fresh local hashes.
    const local = fileList ?? (await this.localHashes());
    const prev = await this.readHeadManifest();
    const prevByPath = new Map((prev?.manifest.files ?? []).map((f) => [f.path, f]));
    let identical = 0;
    let missing = 0;
    let addedBytes = 0;
    for (const f of local) {
      const p = prevByPath.get(f.path);
      if (p && p.sha256 === f.sha256) identical++;
      else {
        missing++;
        addedBytes += f.size;
      }
    }
    const previewId = randomBytes(16).toString('hex');
    const preview: BackupPreview = {
      previewId,
      revision: createHash('sha256').update(JSON.stringify(local)).digest('hex').slice(0, 16),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      summary: { identical, missing, addedBytes },
    };
    nodeFs.mkdirSync(this.opts.previewDir, { recursive: true, mode: 0o700 });
    nodeFs.writeFileSync(path.join(this.opts.previewDir, `${previewId}.backup.json`), JSON.stringify(preview), 'utf-8');
    return preview;
  }
}