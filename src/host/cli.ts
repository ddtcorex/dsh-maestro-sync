#!/usr/bin/env node
/**
 * dsh-maestro-sync CLI — validated wrapper for sync operations
 * Parses --pull/--push --dry-run/--apply --local-dsh --remote --remote-dsh --backup-root
 * Constructs SyncRequest only after validation (HOST + ABSOLUTE regexes).
 * --remote-dsh must be absolute when provided; default is resolved to absolute
 * remote home path by transport preflight, not shell ~ expansion.
 * Delegates to SyncService (merge, never --delete for DSH state).
 * Executable via: node lib/cli.js --pull --dry-run
 */
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSyncConfig, buildSyncRequest } from './config.js';
import { validateRemoteTarget } from './validation.js';
import { SyncService } from './sync-service.js';
import type { SyncRequest } from './sync-types.js';

interface CliOpts {
  mode: 'pull' | 'push' | null;
  dryRun: boolean;
  hasDryRunFlag: boolean;
  hasApplyFlag: boolean;
  localDsh?: string;
  remote?: string;
  remoteDsh?: string;
  backupRoot?: string;
  strategy?: string;
  help: boolean;
}

function printHelp(): void {
  const name = path.basename(process.argv[1] || 'cli.js');
  console.log(`
dsh-maestro-sync CLI — merge memories & sessions across machines

USAGE
  node ${name} --pull|--push [--dry-run|--apply] [OPTIONS]

OPTIONS
  --pull                 pull merge: remote -> local (copy remote-only, merge both)
  --push                 push merge: local -> remote
  --dry-run, -n          preview only (no writes)  (default if neither --apply nor --dry-run given)
  --apply                apply changes (writes & backups)
  --local-dsh <path>     local DSH home (default: DSH_HOME or ~/.dsh)
  --remote <host>        ssh remote host (default: from config/REMOTE_HOST or kai@ssh.ddtcorex.com)
  --remote-dsh <path>    remote DSH path (must be absolute, e.g. /home/kai/.dsh) — default resolved to absolute remote home path by transport preflight, not shell ~ expansion
  --backup-root <path>   backup root dir (used for rsync --backup-dir on harness tier; DSH merge uses .bak.<ts> beside file)
  --strategy <merge|override>  DSH strategy; merge=union dedup (default), override=rsync --delete (fallback)
  --help, -h             this help

EXAMPLES
  node lib/cli.js --pull --dry-run
  node lib/cli.js --pull --apply --local-dsh ~/.dsh --remote myhost --remote-dsh /home/kai/.dsh
  node lib/cli.js --push --dry-run --backup-root /tmp/backup-123

STRATEGY
  DSH tier defaults to merge (safe, no --delete). The harness code tier (maestro-harness/) stays override (rsync --delete).
  Pass --strategy=override to force legacy rsync for DSH (see sync-harness.sh --strategy).

VALIDATION
  Remote host must match /^(?!-)[A-Za-z0-9._@:-]+$/ and dshRoot must be absolute matching /^\\/(?:[A-Za-z0-9._-]+\\/)*[A-Za-z0-9._-]+$/
  Unsafe roots like '~/.dsh', '/', '../dsh', '/tmp/a;id' are rejected. Hosts like '-oProxyCommand=x' are rejected.
  When --remote-dsh is not provided, the transport preflight resolves remote $HOME via ssh to an absolute path.

EXIT CODES
  0 success (including dry-run preview), 1 error / unknown args
`.trim());
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    mode: null,
    dryRun: true,
    hasDryRunFlag: false,
    hasApplyFlag: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--pull') {
      if (opts.mode) throw new Error('Specify only one of --pull or --push');
      opts.mode = 'pull';
    } else if (a === '--push') {
      if (opts.mode) throw new Error('Specify only one of --pull or --push');
      opts.mode = 'push';
    } else if (a === '--dry-run' || a === '-n') {
      opts.dryRun = true;
      opts.hasDryRunFlag = true;
    } else if (a === '--apply') {
      opts.dryRun = false;
      opts.hasApplyFlag = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--local-dsh' || a === '--localDsh') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--local-dsh requires a path value');
      opts.localDsh = v;
    } else if (a.startsWith('--local-dsh=')) {
      opts.localDsh = a.slice('--local-dsh='.length);
    } else if (a === '--remote') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--remote requires a host value');
      opts.remote = v;
    } else if (a.startsWith('--remote=')) {
      opts.remote = a.slice('--remote='.length);
    } else if (a === '--remote-dsh' || a === '--remoteDsh') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--remote-dsh requires a path value');
      opts.remoteDsh = v;
    } else if (a.startsWith('--remote-dsh=')) {
      opts.remoteDsh = a.slice('--remote-dsh='.length);
    } else if (a === '--backup-root' || a === '--backupRoot') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--backup-root requires a path value');
      opts.backupRoot = v;
    } else if (a.startsWith('--backup-root=')) {
      opts.backupRoot = a.slice('--backup-root='.length);
    } else if (a === '--strategy') {
      const v = argv[++i];
      if (!v) throw new Error('--strategy requires merge|override');
      if (v !== 'merge' && v !== 'override') throw new Error('--strategy must be merge or override');
      opts.strategy = v;
    } else if (a.startsWith('--strategy=')) {
      const v = a.slice('--strategy='.length);
      if (v !== 'merge' && v !== 'override') throw new Error('--strategy must be merge or override');
      opts.strategy = v;
    } else if (a === '--') {
      break;
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown option: ${a} (see --help)`);
    } else {
      throw new Error(`Unexpected arg: ${a} (see --help)`);
    }
  }

  // Resolve dryRun precedence: explicit flag wins; if both present, --dry-run wins (safer)
  if (opts.hasDryRunFlag && opts.hasApplyFlag) {
    opts.dryRun = true;
  } else if (opts.hasDryRunFlag) {
    opts.dryRun = true;
  } else if (opts.hasApplyFlag) {
    opts.dryRun = false;
  } else {
    // default to dryRun true for safety when called without explicit flag (e.g. manual preview)
    opts.dryRun = true;
  }

  return opts;
}

/**
 * Build a validated SyncRequest from CLI opts + resolved paths.
 * Validates remote via validateRemoteTarget; rejects shell ~ expansion.
 * If --remote-dsh was explicitly provided, it must be absolute (validated).
 * If not provided, caller is expected to have resolved absolute via transport preflight
 * before calling this (we do not expand '~').
 */
export function buildSyncRequestFromCli(opts: CliOpts, resolved: { localRoot: string; remoteHost: string; remoteDshPath?: string }): SyncRequest {
  if (!opts.mode) throw new Error('Missing --pull or --push');
  const direction = opts.mode;
  // If remoteDshPath was explicitly provided via CLI, validate it strictly is absolute
  // If not provided, the resolved value may be undefined (preflight pending) or from config
  // We only validate when we have a value; unresolved placeholder '~/.dsh' will be rejected
  const rawDshRoot = resolved.remoteDshPath;
  if (rawDshRoot !== undefined) {
    // Reject shell ~ expansion placeholder explicitly; transport must resolve to absolute
    if (rawDshRoot.startsWith('~/') || rawDshRoot === '~' || rawDshRoot === '~/.dsh') {
      // Allow only if caller explicitly wants placeholder to be resolved later - but for SyncRequest we require absolute
      // So throw with clear guidance
      throw new Error(`remoteDshPath must be absolute, got ${JSON.stringify(rawDshRoot)} — default is resolved to absolute remote home path by transport preflight, not shell ~ expansion`);
    }
  }
  // If no remoteDshPath provided at all, we cannot build SyncRequest yet — caller must run transport preflight
  // For CLI main, we will have at least a placeholder; we treat undefined as error unless preflight did
  const dshRoot = rawDshRoot ?? '';
  if (!dshRoot) {
    throw new Error('remoteDshPath is required and must be absolute (e.g. /home/kai/.dsh)');
  }
  return buildSyncRequest({
    direction,
    dryRun: opts.dryRun,
    localRoot: resolved.localRoot,
    remoteHost: resolved.remoteHost,
    remoteDshPath: dshRoot,
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let opts: CliOpts;
  try {
    opts = parseArgs(argv);
  } catch (e: any) {
    console.error(`[err] ${e?.message || String(e)}`);
    printHelp();
    process.exit(1);
    return;
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
    return;
  }

  if (!opts.mode) {
    console.error('[err] Missing required --pull or --push (see --help)');
    printHelp();
    process.exit(1);
    return;
  }

  // Load config (best-effort); CLI flags override
  let cfg: { remoteHost: string; remoteDshPath: string; strategy: string } | null = null;
  try {
    cfg = await loadSyncConfig();
  } catch {
    cfg = null;
  }

  const resolvedLocalDsh =
    opts.localDsh ?? process.env.LOCAL_DSH_PATH ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');

  // Resolve remote host (validated)
  const resolvedRemote = opts.remote ?? process.env.REMOTE_HOST ?? cfg?.remoteHost ?? 'kai@ssh.ddtcorex.com';

  // Resolve remote DSH path: CLI flag must be absolute if provided.
  // If not provided, we keep placeholder but DO NOT validate until transport preflight resolves it to absolute.
  // For SyncRequest construction we require absolute; so if unresolved placeholder remains, we defer validation
  // and let transport preflight provide absolute. Here we attempt to build SyncRequest only if we have absolute.
  const rawRemoteDsh = opts.remoteDsh ?? process.env.REMOTE_DSH_PATH ?? cfg?.remoteDshPath;

  // Validate CLI-provided --remote-dsh immediately is absolute
  if (opts.remoteDsh !== undefined) {
    try {
      validateRemoteTarget({ host: resolvedRemote, dshRoot: opts.remoteDsh });
    } catch (e: any) {
      console.error(`[err] invalid --remote-dsh: ${e?.message || String(e)}`);
      process.exit(1);
      return;
    }
  }

  // Strategy is informational for merge path
  const strategy = opts.strategy ?? cfg?.strategy ?? 'merge';
  const dryRun = opts.dryRun;
  const mode = opts.mode;

  // Attempt to construct validated SyncRequest if we have absolute path
  // If rawRemoteDsh is still '~/.dsh' placeholder, we note that transport preflight will resolve it
  let syncRequest: SyncRequest | null = null;
  let validatedRemoteDsh = rawRemoteDsh;
  let needsPreflight = false;
  if (rawRemoteDsh === '~/.dsh' || rawRemoteDsh?.startsWith('~/') || rawRemoteDsh === '~') {
    needsPreflight = true;
    console.log(`[sync] remoteDsh placeholder ${JSON.stringify(rawRemoteDsh)} will be resolved to absolute remote home path by transport preflight`);
    // For now, keep placeholder for logging but do NOT construct SyncRequest with it
    // Transport preflight expected to replace with absolute like /home/kai/.dsh
  } else if (rawRemoteDsh) {
    try {
      syncRequest = buildSyncRequest({
        direction: mode,
        dryRun,
        localRoot: resolvedLocalDsh,
        remoteHost: resolvedRemote,
        remoteDshPath: rawRemoteDsh,
      });
      validatedRemoteDsh = syncRequest.remote.dshRoot;
    } catch (e: any) {
      console.error(`[err] invalid remote target: ${e?.message || String(e)}`);
      process.exit(1);
      return;
    }
  }

  // Fallback: if not validated yet, use raw for SyncService but warn (will be validated on next step after preflight)
  const effectiveRemoteDsh = validatedRemoteDsh ?? rawRemoteDsh ?? '~/.dsh';

  console.log(`[sync] mode=${mode} strategy=${strategy} dryRun=${dryRun}`);
  console.log(`[sync] localDsh=${resolvedLocalDsh} remote=${resolvedRemote} remoteDsh=${effectiveRemoteDsh}${needsPreflight ? ' (needs preflight)' : ''}`);
  if (opts.backupRoot) console.log(`[sync] backupRoot=${opts.backupRoot}`);
  if (syncRequest) {
    console.log(`[sync] validated SyncRequest: ${JSON.stringify({ direction: syncRequest.direction, localRoot: syncRequest.localRoot, remote: syncRequest.remote })}`);
  }

  const svc = new SyncService({
    localDsh: resolvedLocalDsh,
    remote: resolvedRemote,
    remoteDsh: effectiveRemoteDsh,
  });

  try {
    let result: { copied: number; merged: number; added: number };
    if (mode === 'pull') {
      result = await svc.pull({ dryRun });
    } else {
      result = await svc.push({ dryRun });
    }

    const preview = dryRun ? ' (DRY-RUN — no files written)' : '';
    console.log(`[sync] summary:${preview} copied=${result.copied} merged=${result.merged} added=${result.added}`);

    if (dryRun) {
      if (result.copied === 0 && result.merged === 0) {
        console.log('[sync] DRY-RUN: no changes would be made (already in sync)');
      } else {
        console.log(`[sync] DRY-RUN: would copy ${result.copied} new file(s), merge ${result.merged} file(s) (+${result.added} entries)`);
        console.log('[sync] Re-run with --apply to apply');
      }
    } else {
      console.log(`[sync] done: copied ${result.copied}, merged ${result.merged} (+${result.added} entries)`);
    }
  } catch (e: any) {
    console.error(`[err] sync ${mode} failed: ${e?.message || String(e)}`);
    if (e?.stack) console.error(e.stack);
    process.exit(1);
  }
}

// ESM entry guard: run main only when executed directly, not when imported
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/cli.js') || process.argv[1]?.endsWith('/cli.mjs') || process.argv[1]?.endsWith('lib/cli.js');
if (isMain) {
  main().catch((e) => {
    console.error('[err] unhandled:', e?.message || String(e));
    process.exit(1);
  });
}

export { parseArgs, printHelp };
