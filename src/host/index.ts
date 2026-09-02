// dsh-maestro-sync — Host index: preview/apply tools + loopback RPC (Task 6).
// Mutation exists only through preview-bound apply(confirm:true); the legacy
// pull/push endpoints and tools are preview-only compatibility aliases.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SyncService } from './sync-service.js';
import { loadSyncConfig } from './config.js';
import { BackupService } from './backup-service.js';
import { S3ObjectStore } from './s3-object-store.js';
import { resolveBackupTarget } from './backup-config.js';
import { load } from '@ddtcorex/dsh-maestro-config-lib';
import type { PreviewJobState } from './sync-types.js';

export const RPC_CHANNEL = '/dsh-maestro-sync';

// Async preview jobs: the UI polls previewStatus while the service hashes
// sessions over ssh (count-only). Job state is process-local; the exact
// preview is persisted to the sidecar store by the service itself, so a job
// state loss on restart only loses the in-flight progress, never a preview.
const previewJobs = new Map<string, PreviewJobState>();
const MAX_PREVIEW_JOBS = 8;
const PREVIEW_JOB_IDLE_MS = 120_000;

// Carrier helpers — dsh-client-connection decodes every RPC response as
// { ok: true, value } | { ok: false, error: { code, message, details } }
// (same shape as dsh-maestro-jobs rpc.ts). A handler MUST return this exact
// shape; returning { ok: true, ...flatFields } yields value: undefined on the
// browser side because the connection reads result.value.
function okCarrier<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function failCarrier(message: string, code = 'maestro-sync/rpc', details: Record<string, unknown> = {}): { ok: false; error: { code: string; message: string; details: object } } {
  return { ok: false, error: { code, message, details } };
}

/**
 * Best-effort tunnel profile restore after a confirmed apply.
 * Mirrors sync-harness.sh apply_local_tunnel_profile: re-patches
 * maestro/settings.json domains.tunnel from this machine's own profile dir.
 * Never throws; profile may not exist on CI.
 */
async function restoreTunnelProfile(): Promise<void> {
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const profilesRoot = path.join(dshHome, 'dsh-maestro-remote', 'tunnel-profiles');
    if (!fs.existsSync(profilesRoot)) return;
    let profiles: string[] = [];
    try {
      profiles = fs.readdirSync(profilesRoot).filter((n) => {
        try {
          return fs.statSync(path.join(profilesRoot, n)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return;
    }
    if (profiles.length === 0) return;

    const envProfile = process.env.LOCAL_TUNNEL_PROFILE || process.env.TUNNEL_PROFILE;
    const profileName = envProfile && profiles.includes(envProfile) ? envProfile : profiles[0];
    if (!profileName) return;

    const profileDir = path.join(profilesRoot, profileName);
    const tunnelSettingsPath = path.join(profileDir, 'settings-tunnel.json');
    const cloudflaredSrc = path.join(profileDir, 'cloudflared-config.yml');
    const cloudflaredDst = path.join(dshHome, 'dsh-maestro-remote', 'cloudflared-config.yml');
    const settingsPath = path.join(dshHome, 'maestro', 'settings.json');

    if (!fs.existsSync(tunnelSettingsPath) || !fs.existsSync(settingsPath)) return;

    try {
      if (fs.existsSync(cloudflaredSrc) && fs.existsSync(path.dirname(cloudflaredDst))) {
        fs.copyFileSync(cloudflaredSrc, cloudflaredDst);
        try {
          fs.chmodSync(cloudflaredDst, 0o600);
        } catch {}
      }
    } catch {}

    try {
      const tunnelJson = JSON.parse(fs.readFileSync(tunnelSettingsPath, 'utf-8'));
      const tunnelDomain = tunnelJson?.domains?.tunnel;
      if (!tunnelDomain) return;
      try {
        const cfgLib: any = await import('@ddtcorex/dsh-maestro-config-lib');
        if (typeof cfgLib.set === 'function') {
          await cfgLib.set('tunnel', tunnelDomain);
          return;
        }
      } catch {}
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const doc = JSON.parse(raw);
      doc.domains = doc.domains || {};
      doc.domains.tunnel = tunnelDomain;
      const tmp = settingsPath + '.tmp.' + Math.random().toString(16).slice(2, 6);
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmp, settingsPath);
      try {
        fs.chmodSync(settingsPath, 0o600);
      } catch {}
    } catch {}
  } catch {}
}

function textTool(name: string, description: string, params: Record<string, any>, execute: (args: any) => Promise<string>) {
  return defineTool({
    name,
    description,
    parameters: params,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args: any) {
      return { text: await execute(args ?? {}) };
    },
  });
}

export default {
  inject: ['tools', 'connection'] as const,
  apply(ctx: any) {
    const makeBackupService = async () => {
      const doc = (await load().catch(() => ({ domains: {} as any }))) as any;
      const { config, secrets } = await resolveBackupTarget(doc, process.env as any);
      if (!config.endpoint) throw Object.assign(new Error('backup endpoint not configured'), { phase: 'validate', code: 'MISSING_ENDPOINT' });
      const store = new S3ObjectStore({ endpoint: config.endpoint, region: config.region, accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey });
      const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      return new BackupService({
        localDsh: dshHome,
        store,
        target: { provider: config.provider, bucket: config.bucket, prefix: config.prefix, hostId: config.prefix.split('/')[2] ?? 'host' },
        previewDir: path.join(dshHome, 'dsh-maestro-sync', 'previews'),
        cacheDir: path.join(dshHome, 'dsh-maestro-sync', 'cache'),
      });
    };

    const makeService = async () => {
      const cfg = await loadSyncConfig();
      return new SyncService({ remote: cfg.remoteHost, remoteDsh: cfg.remoteDshPath });
    };

    // maestro_sync_preview — read-only exact plan
    ctx.effect(() =>
      ctx.tools.register(
        textTool(
          'maestro_sync_preview',
          'Preview exact pull/push merge plan (read-only: copy/merge/skip/conflict + added counts)',
          { direction: { type: 'string', enum: ['pull', 'push'], description: 'plan direction' } },
          async ({ direction }) => {
            const svc = await makeService();
            const preview = await svc.preview({ direction: direction === 'push' ? 'push' : 'pull' });
            return JSON.stringify({
              ok: true,
              previewId: preview.previewId,
              revision: preview.revision,
              expiresAt: preview.expiresAt,
              summary: preview.summary,
              actions: preview.actions,
            });
          },
        ),
      ),
    );

    // maestro_sync_apply — the only mutation route (preview-bound, confirm required)
    ctx.effect(() =>
      ctx.tools.register(
        textTool(
          'maestro_sync_apply',
          'Apply a previously previewed plan. Requires previewId, direction and confirm:true.',
          {
            previewId: { type: 'string', description: 'preview id returned by preview' },
            direction: { type: 'string', enum: ['pull', 'push'], description: 'apply direction (must match preview)' },
            confirm: { type: 'boolean', description: 'must be true' },
          },
          async ({ previewId, direction, confirm }) => {
            if (confirm !== true) return JSON.stringify({ ok: false, error: 'apply requires confirm:true' });
            if (!previewId || typeof previewId !== 'string') return JSON.stringify({ ok: false, error: 'apply requires previewId' });
            const svc = await makeService();
            try {
              const r = await svc.apply({ previewId, direction: direction === 'push' ? 'push' : 'pull', confirm: true });
              if (r.ok) await restoreTunnelProfile();
              return JSON.stringify({ ok: r.ok, revision: r.revision, summary: r.summary, committed: r.committed, failures: r.failures });
            } catch (e: any) {
              return JSON.stringify({ ok: false, error: e?.message ?? String(e), code: e?.code, phase: e?.phase });
            }
          },
        ),
      ),
    );

    // maestro_sync_status — bounded cursor-paged file status
    ctx.effect(() =>
      ctx.tools.register(
        textTool(
          'maestro_sync_status',
          'Sync status: counts of local/remote/both files (never implies same content)',
          {},
          async () => {
            const svc = await makeService();
            const st = await svc.status();
            return JSON.stringify({ ok: true, remoteHost: st.remoteHost, connection: st.connection, localOnly: st.localOnly, remoteOnly: st.remoteOnly, both: st.both });
          },
        ),
      ),
    );

    // maestro_sync_pull / maestro_sync_push — preview-only compatibility aliases
    ctx.effect(() =>
      ctx.tools.register(
        textTool(
          'maestro_sync_pull',
          'Deprecated: preview-only pull alias (never writes). Use preview + apply.',
          { dryRun: { type: 'boolean', description: 'ignored — always preview-only' } },
          async () => {
            const svc = await makeService();
            const preview = await svc.preview({ direction: 'pull' });
            return JSON.stringify({ ok: true, previewId: preview.previewId, revision: preview.revision, summary: preview.summary });
          },
        ),
      ),
    );

    ctx.effect(() =>
      ctx.tools.register(
        textTool(
          'maestro_sync_push',
          'Deprecated: preview-only push alias (never writes). Use preview + apply.',
          { dryRun: { type: 'boolean', description: 'ignored — always preview-only' } },
          async () => {
            const svc = await makeService();
            const preview = await svc.preview({ direction: 'push' });
            return JSON.stringify({ ok: true, previewId: preview.previewId, revision: preview.revision, summary: preview.summary });
          },
        ),
      ),
    );


    // Backup / restore / GC tools (R2 Sync tab; mutation routes are
    // preview-bound apply(confirm:true) — mirroring the sync tools).
    ctx.effect(() =>
      ctx.tools.register(
        textTool('maestro_backup_preview', 'Read-only backup preview: what a Backup Apply would upload (missing blobs + bytes).', { direction: { type: 'string' } }, async () => {
          const r = await (await makeBackupService()).preview();
          return JSON.stringify({ ok: true, previewId: r.previewId, summary: r.summary });
        }),
      ),
    );
    ctx.effect(() =>
      ctx.tools.register(
        textTool('maestro_backup_apply', 'Apply a backup preview (single-use): upload blobs, write the manifest, CAS-advance HEAD.', { previewId: { type: 'string' }, confirm: { type: 'boolean' } }, async (a) => {
          if (a.confirm !== true) return JSON.stringify({ ok: false, error: 'backup apply requires confirm:true' });
          const r = await (await makeBackupService()).apply({ previewId: a.previewId, confirm: true });
          return JSON.stringify({ ok: r.ok, committed: r.committed, failures: r.failures });
        }),
      ),
    );
    ctx.effect(() =>
      ctx.tools.register(
        textTool('maestro_restore_preview', 'Read-only restore preview from the backup HEAD manifest (new-dir or in-place).', { mode: { type: 'string' } }, async (a) => {
          const r = await (await makeBackupService()).restorePreview({ mode: a.mode === 'new-dir' ? 'new-dir' : 'in-place' });
          return JSON.stringify({ ok: true, previewId: r.previewId, summary: r.summary });
        }),
      ),
    );
    ctx.effect(() =>
      ctx.tools.register(
        textTool('maestro_restore_apply', 'Apply a restore preview: materialize under a new dir or in place (backups overwritten targets).', { previewId: { type: 'string' }, mode: { type: 'string' }, destDir: { type: 'string' }, confirm: { type: 'boolean' } }, async (a) => {
          if (a.confirm !== true) return JSON.stringify({ ok: false, error: 'restore apply requires confirm:true' });
          const r = await (await makeBackupService()).restoreApply({ previewId: a.previewId, mode: a.mode === 'new-dir' ? 'new-dir' : 'in-place', destDir: a.destDir, confirm: true });
          return JSON.stringify({ ok: r.ok, committed: r.committed, failures: r.failures });
        }),
      ),
    );
    ctx.effect(() =>
      ctx.tools.register(
        textTool('maestro_backup_gc_preview', 'Read-only retention GC preview: unreachable blobs + freed bytes.', {}, async () => {
          const r = await (await makeBackupService()).gcPreview({});
          return JSON.stringify({ ok: true, previewId: r.previewId, deletable: r.deletableBlobs.length, freedBytes: r.freedBytes });
        }),
      ),
    );
    ctx.effect(() =>
      ctx.tools.register(
        textTool('maestro_backup_gc_apply', 'Apply a GC preview: delete the listed unreachable blobs.', { previewId: { type: 'string' }, confirm: { type: 'boolean' } }, async (a) => {
          if (a.confirm !== true) return JSON.stringify({ ok: false, error: 'gc apply requires confirm:true' });
          const r = await (await makeBackupService()).gcApply({ previewId: a.previewId, confirm: true });
          return JSON.stringify({ ok: r.ok, deleted: r.deleted, freedBytes: r.freedBytes });
        }),
      ),
    );

    // Loopback RPC for the Settings UI
    ctx.effect(() =>
      ctx.connection.rpc.handle(
        RPC_CHANNEL,
        async (method: string, args: any) => {
          const svc = await makeService();
          try {
            switch (String(method)) {
              case 'pull':
              case 'push': {
                // preview-only compatibility: no argument (including dryRun) can apply
                const preview = await svc.preview({ direction: method === 'push' ? 'push' : 'pull' });
                return okCarrier({ previewId: preview.previewId, revision: preview.revision, expiresAt: preview.expiresAt, summary: preview.summary });
              }
              case 'status': {
                if (args && typeof args.bucket === 'string') {
                  const page = await svc.statusPage({ bucket: args.bucket, cursor: args.cursor, limit: args.limit });
                  return okCarrier({ total: page.total, offset: page.offset, limit: page.limit, files: page.files, nextCursor: page.nextCursor, connection: page.connection, remoteHost: page.remoteHost });
                }
                const r = await svc.status();
                return okCarrier({ remoteHost: r.remoteHost, connection: r.connection, localOnly: r.localOnly, remoteOnly: r.remoteOnly, both: r.both });
              }
              case 'check': {
                const r = await svc.checkConnection();
                return okCarrier({ connection: r, remoteHost: r.host });
              }
              case 'preview': {
                const dir = (args && (args as any).direction) === 'push' ? 'push' : 'pull';
                const r = await svc.preview({ direction: dir });
                return okCarrier({ previewId: r.previewId, revision: r.revision, expiresAt: r.expiresAt, actions: r.actions, summary: r.summary, sessionCounts: r.sessionCounts, connection: r.connection, remoteHost: r.remoteHost });
              }
              case 'previewStart': {
                // Count-only sessions (no content staged) + per-file progress;
                // returns a jobId immediately, the UI polls previewStatus.
                const dir = (args && (args as any).direction) === 'push' ? 'push' : 'pull';
                const jobId = randomBytes(8).toString('hex');
                const state: PreviewJobState = { status: 'running', progress: { phase: 'listing', current: 0, total: 1 } };
                (state as any).cancelled = false;
                (state as any).ts = Date.now();
                previewJobs.set(jobId, state);
                if (previewJobs.size > MAX_PREVIEW_JOBS) {
                  const oldest = [...previewJobs.entries()].sort((a, b) => ((a[1] as any).ts ?? 0) - ((b[1] as any).ts ?? 0))[0];
                  if (oldest) previewJobs.delete(oldest[0]);
                }
                void (async () => {
                  try {
                    const r = await svc.preview({
                      direction: dir,
                      sessionsCountOnly: true,
                      onProgress: (p) => {
                        const s = previewJobs.get(jobId);
                        if (s && s.status !== 'cancelled') {
                          s.progress = p;
                          (s as any).ts = Date.now();
                        }
                      },
                      shouldStop: () => {
                        const s = previewJobs.get(jobId);
                        return s !== undefined && (s as any).cancelled === true;
                      },
                    });
                    const s = previewJobs.get(jobId);
                    if (s) {
                      s.status = 'done';
                      s.preview = { previewId: r.previewId, revision: r.revision, expiresAt: r.expiresAt, actions: r.actions, summary: r.summary, sessionCounts: r.sessionCounts, connection: (r as any).connection, remoteHost: (r as any).remoteHost } as any;
                      (s as any).ts = Date.now();
                    }
                  } catch (e: any) {
                    const s = previewJobs.get(jobId);
                    if (s) {
                      if (s.status !== 'cancelled') {
                        s.status = e?.code === 'CANCELLED' ? 'cancelled' : 'error';
                        s.error = e?.message ?? String(e);
                      }
                      (s as any).ts = Date.now();
                    }
                  }
                })();
                return okCarrier({ jobId, status: 'running' });
              }
              case 'previewCancel': {
                const jobId = args && (args as any).jobId;
                const s = jobId && typeof jobId === 'string' ? previewJobs.get(jobId) : undefined;
                if (!s) return failCarrier('preview job not found', 'maestro-sync/preview-job');
                (s as any).cancelled = true;
                s.status = 'cancelled';
                (s as any).ts = Date.now();
                return okCarrier({ ok: true });
              }
              case 'previewStatus': {
                const jobId = args && (args as any).jobId;
                if (!jobId || typeof jobId !== 'string' || !previewJobs.has(jobId)) return failCarrier('preview job not found', 'maestro-sync/preview-job');
                const s = previewJobs.get(jobId)!;
                const idleMs = Date.now() - ((s as any).ts ?? Date.now());
                if (idleMs > PREVIEW_JOB_IDLE_MS) {
                  previewJobs.delete(jobId);
                  return failCarrier('preview job expired', 'maestro-sync/preview-job');
                }
                return okCarrier({
                  status: s.status,
                  progress: s.progress,
                  preview: s.preview,
                  error: s.error,
                });
              }
              case 'apply': {
                const previewId = args && (args as any).previewId;
                const direction = args && (args as any).direction === 'push' ? 'push' : 'pull';
                const confirm = args && (args as any).confirm;
                if (confirm !== true) return failCarrier('apply requires confirm:true');
                if (!previewId || typeof previewId !== 'string') return failCarrier('apply requires previewId');
                const r = await svc.apply({ previewId, direction, confirm: true });
                if (r.ok) await restoreTunnelProfile();
                return okCarrier({ revision: r.revision, summary: r.summary, committed: r.committed, failures: r.failures });
              }
              case 'backupStatus': {
                try {
                  const bsvc = await makeBackupService();
                  const head = await bsvc.readHeadManifest();
                  return okCarrier({
                    configured: true,
                    source: (await resolveBackupTarget((await load().catch(() => ({ domains: {} as any }))) as any, process.env as any)).source,
                    bucket: (await resolveBackupTarget((await load().catch(() => ({ domains: {} as any }))) as any, process.env as any)).config.bucket,
                    prefix: (await resolveBackupTarget((await load().catch(() => ({ domains: {} as any }))) as any, process.env as any)).config.prefix,
                    lastManifest: head ? head.key : null,
                    eligible: { md: bsvc.listEligibleFiles().filter((p: string) => p.endsWith('.md')).length, sessions: bsvc.listEligibleFiles().filter((p: string) => p.endsWith('.jsonl.zstd')).length },
                  });
                } catch (e: any) {
                  return okCarrier({ configured: false, source: 'none', bucket: '', prefix: '', lastManifest: null, eligible: { md: 0, sessions: 0 }, error: e?.message ?? String(e) });
                }
              }
              case 'backupPreview': {
                const r = await (await makeBackupService()).preview();
                return okCarrier({ previewId: r.previewId, revision: r.revision, expiresAt: r.expiresAt, summary: r.summary });
              }
              case 'backupApply': {
                const { previewId, confirm } = (args ?? {}) as any;
                if (confirm !== true) return failCarrier('backup apply requires confirm:true', 'maestro-sync/confirm');
                const r = await (await makeBackupService()).apply({ previewId, confirm: true });
                return r.ok ? okCarrier({ ok: true, committed: r.committed, failures: r.failures }) : failCarrier('backup apply failed', 'maestro-sync/backup', { failures: r.failures } as any);
              }
              case 'restorePreview': {
                const mode = (args as any)?.mode === 'new-dir' ? 'new-dir' : 'in-place';
                const r = await (await makeBackupService()).restorePreview({ mode });
                return okCarrier(r);
              }
              case 'restoreApply': {
                const { previewId, mode, destDir, confirm } = (args ?? {}) as any;
                if (confirm !== true) return failCarrier('restore apply requires confirm:true', 'maestro-sync/confirm');
                const r = await (await makeBackupService()).restoreApply({ previewId, mode, destDir, confirm: true });
                return r.ok ? okCarrier({ ok: true, committed: r.committed, failures: r.failures }) : failCarrier('restore apply failed', 'maestro-sync/restore', { failures: r.failures } as any);
              }
              case 'backupGcPreview': {
                const r = await (await makeBackupService()).gcPreview({});
                return okCarrier(r);
              }
              case 'backupGcApply': {
                const { previewId, confirm } = (args ?? {}) as any;
                if (confirm !== true) return failCarrier('gc apply requires confirm:true', 'maestro-sync/confirm');
                const r = await (await makeBackupService()).gcApply({ previewId, confirm: true });
                return okCarrier(r);
              }
              default:
                return failCarrier('unknown method: ' + String(method));
            }
          } catch (e: any) {
            const details: Record<string, unknown> = {};
            if (e?.phase) details.phase = e?.phase;
            return failCarrier(e?.message ?? String(e), e?.code ?? 'maestro-sync/rpc', details);
          }
        },
        { authority: 'loopback' },
      ),
    );
  },
};