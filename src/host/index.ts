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
                        if (s) {
                          s.progress = p;
                          (s as any).ts = Date.now();
                        }
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
                      s.status = 'error';
                      s.error = e?.message ?? String(e);
                      (s as any).ts = Date.now();
                    }
                  }
                })();
                return okCarrier({ jobId, status: 'running' });
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