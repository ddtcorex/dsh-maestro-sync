/**
 * Hermetic two-root rehearsal transport.
 *
 * The "remote" is a real local directory with the same layout as a remote DSH
 * home. list/stage/upload mirror SshRsyncTransport semantics on real bytes,
 * ensureAgent installs the real POSIX helper, and commit executes the REAL
 * remote-agent script via bash against the real directory — so the rehearsal
 * covers real files, real Zstd artifacts, real CAS and real atomic renames
 * without any network access.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { SyncTransport } from '../../src/host/transport.js';
import type { RemoteTarget } from '../../src/host/sync-types.js';
import type { RemoteManifestEntry } from '../../src/host/remote-manifest.js';
import { remoteAgentSource, REMOTE_AGENT_REL } from '../../src/host/remote-agent.js';
import { normalizeEligiblePath } from '../../src/host/validation.js';

export class LocalRehearsalTransport implements SyncTransport {
  constructor(private readonly remoteRoot: string) {}

  async remoteHome(): Promise<string> {
    return path.dirname(this.remoteRoot);
  }

  private sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  async hashes(_target: RemoteTarget, paths: readonly string[]): Promise<RemoteManifestEntry[]> {
    return this.manifest(_target);
  }

  async manifest(_target: RemoteTarget): Promise<RemoteManifestEntry[]> {
    const out: RemoteManifestEntry[] = [];
    const walk = (dir: string, base: string) => {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) walk(full, path.join(base, name.name));
        else {
          const rel = path.join(base, name.name).split(path.sep).join('/');
          try {
            normalizeEligiblePath(rel);
          } catch {
            continue;
          }
          const buf = fs.readFileSync(full);
          out.push({ path: rel, sha256: this.sha256(buf), size: buf.length, mtimeSec: 0 });
        }
      }
    };
    if (fs.existsSync(this.remoteRoot)) walk(this.remoteRoot, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async stage(_target: RemoteTarget, paths: readonly string[], destination: string): Promise<void> {
    for (const rel of paths) {
      const buf = fs.readFileSync(path.join(this.remoteRoot, rel));
      const full = path.join(destination, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
    }
  }

  async upload(_target: RemoteTarget, source: string, paths: readonly string[], operationId: string): Promise<void> {
    for (const rel of paths) {
      const buf = fs.readFileSync(path.join(source, rel));
      const full = path.join(this.remoteRoot, '.maestro-sync', 'stage', operationId, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
    }
  }

  async ensureAgent(): Promise<void> {
    const bin = path.join(this.remoteRoot, '.maestro-sync', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, REMOTE_AGENT_REL.split('/').pop()!), remoteAgentSource(), { mode: 0o700 });
  }

  async warmCache(): Promise<void> {
    // Mirror the real warm script: write <root>/.maestro-sync/fp.tsv fresh.
    const manifest = await this.manifest({ host: 'local', dshRoot: this.remoteRoot });
    const lines = manifest
      .map((e) => {
        const full = path.join(this.remoteRoot, e.path);
        const st = fs.statSync(full, { bigint: true });
        return `${e.path}\t${st.ino}\t${st.size}\t${st.mtimeNs}\t${st.ctimeNs}\t${e.sha256}`;
      })
      .join('\n');
    const dir = path.join(this.remoteRoot, '.maestro-sync');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fp.tsv'), lines + '\n');
  }

  async commit(_target: RemoteTarget, operationId: string, manifest: Buffer): Promise<void> {
    const helper = path.join(this.remoteRoot, REMOTE_AGENT_REL);
    if (!fs.existsSync(helper)) throw new Error('remote agent not installed');
    const res = spawnSync(helper, [operationId], { input: manifest, encoding: 'utf-8' });
    if (res.status !== 0) {
      const stderr = res.stderr ?? '';
      throw Object.assign(new Error(`commit failed: ${stderr || `exit ${res.status}`}`), {
        phase: 'publish',
        code: stderr.includes('CONCURRENT_MODIFICATION') ? 'CONCURRENT_MODIFICATION' : 'COMMIT_FAILED',
      });
    }
  }
}