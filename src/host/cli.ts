#!/usr/bin/env node
/**
 * dsh-maestro-sync CLI — validated, preview-first wrapper for sync operations.
 *
 *   node lib/cli.js --pull [--dry-run]                      -> preview only (default)
 *   node lib/cli.js --pull --apply --preview-id ID --confirm -> apply a preview
 *
 * No omitted boolean can apply a sync: `--apply` requires BOTH `--preview-id`
 * and `--confirm`. `--strategy=override` is a destructive escape hatch and
 * requires a separate `--ack-override` flag. The CLI emits one final JSON
 * result to stdout and human progress to stderr. Executable via:
 *   node lib/cli.js --pull --dry-run
 */
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSyncConfig, type SyncConfig } from './config.js';
import { validateHost } from './validation.js';
import { SyncService } from './sync-service.js';
import type { SyncDirection } from './sync-types.js';

interface CliDeps {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  makeService?: (cfg: SyncConfig) => Promise<SyncService>;
}

interface CliOpts {
  mode: 'pull' | 'push' | null;
  dryRun: boolean;
  hasApplyFlag: boolean;
  applyPreviewId?: string;
  confirm: boolean;
  localDsh?: string;
  remote?: string;
  remoteDsh?: string;
  backupRoot?: string;
  strategy: 'merge' | 'override';
  ackOverride: boolean;
  help: boolean;
}

function printHelp(prog: string): string {
  return `
dsh-maestro-sync CLI — merge memories & sessions across machines

USAGE
  node ${prog} --pull|--push [--dry-run]                 preview (default, read-only)
  node ${prog} --pull|--push --apply --preview-id ID --confirm   apply a preview

OPTIONS
  --pull                    pull merge: remote -> local
  --push                    push merge: local -> remote
  --dry-run, -n             preview only (default); never writes
  --apply                   apply a previous preview — REQUIRES --preview-id and --confirm
  --preview-id <id>         preview id returned by --dry-run
  --confirm                 explicit confirmation that the preview may be applied
  --local-dsh <path>        local DSH home (default: DSH_HOME or ~/.dsh)
  --remote <host>           ssh remote host (default: from config/REMOTE_HOST)
  --remote-dsh <path>       remote DSH path; must be absolute (e.g. /home/kai/.dsh);
                            a '~/.dsh' default is resolved to an absolute remote home
                            path by the transport preflight, never shell ~ expansion
  --strategy <merge|override>  merge (default): union dedup, no --delete.
                            override: destructive rsync --delete mirror — REQUIRES --ack-override
  --ack-override            acknowledge that --strategy=override is destructive
  --backup-root <path>      accepted for compatibility; DSH publishes .bak.<ts> beside each file
  --help, -h                this help

EXIT CODES
  0 success (including a dry-run preview), 1 error / apply partial failure
`.trim();
}

export function parseArgs(argv: string[], err: (s: string) => void): CliOpts | null {
  const opts: CliOpts = {
    mode: null,
    dryRun: true,
    hasApplyFlag: false,
    confirm: false,
    strategy: 'merge',
    ackOverride: false,
    help: false,
  };

  const fail = (msg: string): CliOpts | null => {
    err(`[err] ${msg}`);
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--pull' || a === '--push') {
      if (opts.mode) return fail('Specify only one of --pull or --push');
      opts.mode = a === '--pull' ? 'pull' : 'push';
    } else if (a === '--dry-run' || a === '-n') {
      opts.dryRun = true;
    } else if (a === '--apply') {
      opts.hasApplyFlag = true;
      opts.dryRun = false;
    } else if (a === '--confirm') {
      opts.confirm = true;
    } else if (a === '--preview-id') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) return fail('--preview-id requires a value');
      opts.applyPreviewId = v;
    } else if (a.startsWith('--preview-id=')) {
      opts.applyPreviewId = a.slice('--preview-id='.length);
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--local-dsh' || a === '--localDsh') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) return fail('--local-dsh requires a path value');
      opts.localDsh = v;
    } else if (a === '--remote') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) return fail('--remote requires a host value');
      opts.remote = v;
    } else if (a.startsWith('--remote=')) {
      opts.remote = a.slice('--remote='.length);
    } else if (a === '--remote-dsh' || a === '--remoteDsh') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) return fail('--remote-dsh requires a path value');
      opts.remoteDsh = v;
    } else if (a.startsWith('--remote-dsh=')) {
      opts.remoteDsh = a.slice('--remote-dsh='.length);
    } else if (a === '--backup-root' || a === '--backupRoot') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) return fail('--backup-root requires a path value');
      opts.backupRoot = v;
    } else if (a === '--strategy') {
      const v = argv[++i];
      if (!v || (v !== 'merge' && v !== 'override')) return fail('--strategy must be merge or override');
      opts.strategy = v;
    } else if (a.startsWith('--strategy=')) {
      const v = a.slice('--strategy='.length);
      if (v !== 'merge' && v !== 'override') return fail('--strategy must be merge or override');
      opts.strategy = v;
    } else if (a === '--ack-override') {
      opts.ackOverride = true;
    } else if (a === '--') {
      break;
    } else if (a.startsWith('-')) {
      return fail(`Unknown option: ${a} (see --help)`);
    } else {
      return fail(`Unexpected arg: ${a} (see --help)`);
    }
  }

  if (opts.strategy === 'override' && !opts.ackOverride) {
    return fail('--strategy=override is destructive and requires --ack-override');
  }
  if (opts.hasApplyFlag) {
    if (!opts.applyPreviewId) return fail('--apply requires --preview-id <id> from a previous --dry-run preview');
    if (opts.confirm !== true) return fail('--apply requires --confirm');
  }
  return opts;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));

  const opts = parseArgs(argv, err);
  if (!opts) return 1;
  if (opts.help) {
    out(printHelp(path.basename(process.argv[1] || 'cli.js')) + '\n');
    return 0;
  }
  if (!opts.mode) {
    err('[err] Missing required --pull or --push (see --help)');
    return 1;
  }
  const direction: SyncDirection = opts.mode;

  let cfg: SyncConfig;
  try {
    cfg = await loadSyncConfig();
  } catch {
    cfg = { remoteHost: process.env.REMOTE_HOST || 'kai@ssh.ddtcorex.com', remoteDshPath: '~/.dsh', strategy: 'merge' };
  }
  const resolvedRemote = opts.remote ?? cfg.remoteHost;
  try {
    validateHost(resolvedRemote);
  } catch (e: any) {
    err(`[err] invalid --remote host: ${e?.message ?? String(e)}`);
    return 1;
  }
  const resolvedRemoteDsh = opts.remoteDsh ?? cfg.remoteDshPath;
  const resolvedLocalDsh = opts.localDsh ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');

  let svc: SyncService;
  if (deps.makeService) {
    svc = await deps.makeService({ ...cfg, remoteHost: resolvedRemote, remoteDshPath: resolvedRemoteDsh, strategy: opts.strategy });
  } else {
    svc = new SyncService({ localDsh: resolvedLocalDsh, remote: resolvedRemote, remoteDsh: resolvedRemoteDsh });
  }

  if (opts.hasApplyFlag) {
    err(`[sync] apply ${direction} preview ${opts.applyPreviewId} (strategy ${opts.strategy})`);
    let result;
    try {
      result = await svc.apply({ previewId: opts.applyPreviewId!, direction, confirm: true });
    } catch (e: any) {
      out(JSON.stringify({ ok: false, error: e?.message ?? String(e), code: e?.code, phase: e?.phase }) + '\n');
      err(`[err] apply failed: ${e?.message ?? String(e)}`);
      return 1;
    }
    out(JSON.stringify({ ok: result.ok, revision: result.revision, summary: result.summary, committed: result.committed, failures: result.failures }) + '\n');
    if (!result.ok) {
      err(`[err] apply partially failed: ${result.failures.map((f: any) => f.path).join(',')}`);
      return 1;
    }
    err(`[sync] applied: committed ${result.committed.length}, failures ${result.failures.length}`);
    return 0;
  }

  // default: dry-run preview (read-only)
  err(`[sync] preview ${direction} (dry-run, strategy ${opts.strategy}) localDsh=${resolvedLocalDsh} remote=${resolvedRemote} remoteDsh=${resolvedRemoteDsh}`);
  let preview;
  try {
    preview = await svc.preview({ direction });
  } catch (e: any) {
    out(JSON.stringify({ ok: false, error: e?.message ?? String(e), code: e?.code, phase: e?.phase }) + '\n');
    err(`[err] preview failed: ${e?.message ?? String(e)}`);
    return 1;
  }
  out(JSON.stringify({ ok: true, previewId: preview.previewId, revision: preview.revision, expiresAt: preview.expiresAt, summary: preview.summary, actions: preview.actions }) + '\n');
  err(`[sync] preview ${preview.previewId}: copied=${preview.summary.copied} merged=${preview.summary.merged} skipped=${preview.summary.skipped} conflicts=${preview.summary.conflicts} added=${preview.summary.added}`);
  return 0;
}

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/cli.js') ||
  process.argv[1]?.endsWith('/cli.mjs') ||
  process.argv[1]?.endsWith('lib/cli.js');
if (isMain) {
  main().catch((e) => {
    console.error('[err] unhandled:', e?.message || String(e));
    process.exitCode = 1;
  });
}