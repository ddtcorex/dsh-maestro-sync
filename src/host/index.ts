// dsh-maestro-sync — Host index with tools + RPC (Task 5)
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SyncService } from './sync-service.js';
import { loadSyncConfig } from './config.js';

export const RPC_CHANNEL = '/dsh-maestro-sync';

/**
 * Best-effort tunnel profile restore after pull/push.
 * Mirrors sync-harness.sh apply_local_tunnel_profile:
 * - reads tunnel-profiles/<profile>/settings-tunnel.json and cloudflared-config.yml
 * - re-patches maestro/settings.json via config-lib (or direct fs fallback)
 * No throw — failures are ignored (profile may not exist on CI).
 */
async function restoreTunnelProfile(): Promise<void> {
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    // Attempt to load via config-lib first to get tunnel domain, then restore
    // For minimal implementation, just try fs-based restore if profile exists
    const profilesRoot = path.join(dshHome, 'dsh-maestro-remote', 'tunnel-profiles');
    if (!fs.existsSync(profilesRoot)) return;
    // list profiles
    let profiles: string[] = [];
    try {
      profiles = fs.readdirSync(profilesRoot).filter((n) => {
        try { return fs.statSync(path.join(profilesRoot, n)).isDirectory(); } catch { return false; }
      });
    } catch { return; }
    if (profiles.length === 0) return;

    // Prefer LOCAL_TUNNEL_PROFILE env or first profile
    const envProfile = process.env.LOCAL_TUNNEL_PROFILE || process.env.TUNNEL_PROFILE;
    const profileName = envProfile && profiles.includes(envProfile) ? envProfile : profiles[0];
    if (!profileName) return;

    const profileDir = path.join(profilesRoot, profileName);
    const tunnelSettingsPath = path.join(profileDir, 'settings-tunnel.json');
    const cloudflaredSrc = path.join(profileDir, 'cloudflared-config.yml');
    const cloudflaredDst = path.join(dshHome, 'dsh-maestro-remote', 'cloudflared-config.yml');
    const settingsPath = path.join(dshHome, 'maestro', 'settings.json');

    if (!fs.existsSync(tunnelSettingsPath) || !fs.existsSync(settingsPath)) return;

    // Patch cloudflared config if present
    try {
      if (fs.existsSync(cloudflaredSrc) && fs.existsSync(path.dirname(cloudflaredDst))) {
        fs.copyFileSync(cloudflaredSrc, cloudflaredDst);
        try { fs.chmodSync(cloudflaredDst, 0o600); } catch {}
      }
    } catch {}

    // Patch settings.json domains.tunnel via raw fs (fallback) and via config-lib if available
    try {
      const tunnelJson = JSON.parse(fs.readFileSync(tunnelSettingsPath, 'utf-8'));
      const tunnelDomain = tunnelJson?.domains?.tunnel;
      if (!tunnelDomain) return;

      // Try config-lib patch first
      try {
        const cfgLib: any = await import('@ddtcorex/dsh-maestro-config-lib');
        if (typeof cfgLib.load === 'function' && typeof cfgLib.get === 'function') {
          // Use generic set if available
          if (typeof cfgLib.set === 'function') {
            await cfgLib.set('tunnel', tunnelDomain);
            return;
          }
        }
      } catch {}

      // Fallback: direct JSON patch
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const doc = JSON.parse(raw);
      doc.domains = doc.domains || {};
      doc.domains.tunnel = tunnelDomain;
      const tmp = settingsPath + '.tmp.' + Math.random().toString(16).slice(2, 6);
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmp, settingsPath);
      try { fs.chmodSync(settingsPath, 0o600); } catch {}
    } catch {}
  } catch {}
}

export default {
  inject: ['tools', 'connection'] as const,
  apply(ctx: any) {
    // maestro_sync_pull
    ctx.effect(() =>
      ctx.tools.register(defineTool({
        name: 'maestro_sync_pull',
        description: 'Pull merge DSH state remote->local',
        parameters: {
          dryRun: { type: 'boolean', description: 'preview without writing' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute({ dryRun }) {
          const cfg = await loadSyncConfig();
          const svc = new SyncService({ remote: cfg.remoteHost, remoteDsh: cfg.remoteDshPath });
          const result = await svc.pull({ dryRun: !!dryRun });
          if (!dryRun) await restoreTunnelProfile();
          return { text: JSON.stringify({ ok: true, ...result }) };
        },
      })),
    );

    // maestro_sync_push
    ctx.effect(() =>
      ctx.tools.register(defineTool({
        name: 'maestro_sync_push',
        description: 'Push merge DSH state local->remote',
        parameters: {
          dryRun: { type: 'boolean', description: 'preview without writing' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute({ dryRun }) {
          const cfg = await loadSyncConfig();
          const svc = new SyncService({ remote: cfg.remoteHost, remoteDsh: cfg.remoteDshPath });
          const result = await svc.push({ dryRun: !!dryRun });
          if (!dryRun) await restoreTunnelProfile();
          return { text: JSON.stringify({ ok: true, ...result }) };
        },
      })),
    );

    // maestro_sync_status
    ctx.effect(() =>
      ctx.tools.register(defineTool({
        name: 'maestro_sync_status',
        description: 'Sync status: counts of local/remote/both files',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute() {
          const cfg = await loadSyncConfig();
          const svc = new SyncService({ remote: cfg.remoteHost, remoteDsh: cfg.remoteDshPath });
          const st = await svc.status();
          return { text: JSON.stringify({ ok: true, ...st }) };
        },
      })),
    );

    // Loopback RPC for Settings UI
    ctx.effect(() =>
      ctx.connection.rpc.handle(
        RPC_CHANNEL,
        async (method: string, args: any) => {
          const cfg = await loadSyncConfig();
          const svc = new SyncService({ remote: cfg.remoteHost, remoteDsh: cfg.remoteDshPath });
          const dryRun = !!(args && (args as any).dryRun);
          switch (String(method)) {
            case 'pull': {
              const r = await svc.pull({ dryRun });
              if (!dryRun) await restoreTunnelProfile();
              return { ok: true, ...r };
            }
            case 'push': {
              const r = await svc.push({ dryRun });
              if (!dryRun) await restoreTunnelProfile();
              return { ok: true, ...r };
            }
            case 'status': {
              const r = await svc.status();
              // slim file lists to stay within 64KB RPC limit (original 919 files ~95KB -> slim 8 files ~1.4KB)
              const slim = {
                localOnly: (r as any).localOnly,
                remoteOnly: (r as any).remoteOnly,
                both: (r as any).both,
                localOnlyFiles: (r as any).localOnlyFiles?.slice(0, 8) ?? [],
                remoteOnlyFiles: (r as any).remoteOnlyFiles?.slice(0, 8) ?? [],
                bothFiles: (r as any).bothFiles?.slice(0, 8) ?? [],
                connection: (r as any).connection,
                remoteHost: (r as any).remoteHost,
              };
              try {
                const len = JSON.stringify(r).length;
                const slimLen = JSON.stringify(slim).length;
                console.log('[maestro-sync] status', JSON.stringify({ remoteHost: (r as any).remoteHost, conn: (r as any).connection, localOnly: (r as any).localOnly, remoteOnly: (r as any).remoteOnly, both: (r as any).both, len, slimLen, keys: Object.keys(slim) }).slice(0, 2000));
                console.log('[maestro-sync] slim', JSON.stringify(slim).slice(0, 2000));
              } catch {}
              return { ok: true, ...slim };
            }
            case 'check': {
              const r = await svc.checkConnection();
              return { ok: true, connection: r, remoteHost: cfg.remoteHost };
            }
            case 'preview': {
              const dir = (args && (args as any).direction) === 'push' ? 'push' : 'pull';
              const r = await svc.preview({ direction: dir as any });
              return { ok: true, ...r };
            }
            case 'apply': {
              const previewId = args && (args as any).previewId;
              const direction = args && (args as any).direction === 'push' ? 'push' : 'pull';
              const confirm = args && (args as any).confirm;
              if (confirm !== true) return { ok: false, error: 'apply requires confirm:true' };
              if (!previewId || typeof previewId !== 'string') return { ok: false, error: 'apply requires previewId' };
              try {
                const r = await svc.apply({ previewId, direction: direction as any, confirm: true });
                return r as any;
              } catch (e: any) {
                return { ok: false, error: e?.message ?? String(e), code: e?.code, phase: e?.phase };
              }
            }
            default:
              return { ok: false, error: 'unknown method: ' + String(method) };
          }
        },
        { authority: 'loopback' },
      ),
    );
  },
};
