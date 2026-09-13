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
import { DEFAULT_REMOTE_HOST, loadSyncConfig, type SyncConfig } from './config.js';
import { validateHost } from './validation.js';
import { SyncService } from './sync-service.js';
import { runBidirectionalApply, runBidirectionalPreview } from './bidirectional.js';
import type { SyncDirection, SyncScope } from './sync-types.js';
import { checkMachines, isMachineId, peerMachineId, readLocalMachineId, type MachineMode } from './machine-id.js';
import { restoreLocalTunnel, restoreRemoteTunnel } from './tunnel-restore.js';
import { clearPeerHost, writePeerHost } from './peer-host.js';
import { NodeProcessRunner } from './process-runner.js';
import { SshRsyncTransport } from './transport.js';

interface CliDeps {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  makeService?: (cfg: SyncConfig) => Promise<SyncService>;
  /** Hermetic seam for the machine-identity reads (defaults hit real fs/ssh). */
  identity?: {
    readLocal?: (dshHome: string) => Promise<string | null>;
    readRemote?: (host: string, remoteDsh: string) => Promise<string | null>;
  };
}

interface CliOpts {
  mode: 'pull' | 'push' | 'bidirectional' | null;
  subcommand: 'check-machines' | 'tunnel-restore' | 'set-peer-host' | null;
  dryRun: boolean;
  hasApplyFlag: boolean;
  applyPreviewId?: string;
  confirm: boolean;
  includeSessions: boolean;
  from?: string;
  to?: string;
  side?: string;
  profile?: string;
  peerHost?: string;
  clearPeer?: boolean;
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
dsh-maestro-sync CLI — merge memory & sessions across machines

USAGE
  node ${prog} --pull|--push [--dry-run]                 preview (default, read-only)
  node ${prog} --pull|--push --apply --preview-id ID --confirm   apply a preview
  node ${prog} --bidirectional [--dry-run] [--include-sessions]  push-then-pull in one operation
  node ${prog} --bidirectional --apply --preview-id ID --confirm apply it
  node ${prog} check-machines [--pull|--push|--bidirectional] [--from X --to Y]
  node ${prog} tunnel-restore --side local|remote [--profile NAME] --confirm
  node ${prog} set-peer-host --host HOST | --clear

OPTIONS
  --pull                    pull merge: remote -> local
  --push                    push merge: local -> remote
  --bidirectional           push then pull, one operation (merge strategy only)
  --include-sessions        with --bidirectional: also sync sessions/ (default: memories only)
  --from/--to <id>          absolute machines, by the id each side wrote to its
                            $DSH_HOME/machine-id; identity is enforced before
                            any preview/apply (from defaults to the local
                            machine-id, to defaults to its peer)
  --dry-run, -n             preview only (default); never writes
  --apply                   apply a previous preview — REQUIRES --preview-id and --confirm
  --preview-id <id>         preview id returned by --dry-run
  --confirm                 explicit confirmation that the preview may be applied
  --local-dsh <path>        local DSH home (default: DSH_HOME or ~/.dsh)
  --host <host>             with set-peer-host: this machine's peer ssh target
  --clear                   with set-peer-host: drop the machine-local peer
  --remote <host>           ssh remote host (default: from config/REMOTE_HOST)
  --remote-dsh <path>       remote DSH path; must be absolute (e.g. /home/kai/.dsh);
                            a '~/.dsh' default is resolved to an absolute remote home
                            path by the transport preflight, never shell ~ expansion
  --strategy <merge|override>  merge (default): union dedup, no --delete.
                            override: destructive rsync --delete mirror — REQUIRES --ack-override
  --ack-override            acknowledge that --strategy=override is destructive
  --backup-root <path>      accepted for compatibility; DSH publishes .bak.<ts> beside each file
  --side <local|remote>     with tunnel-restore: which side to restore (default local)
  --profile <name>          with tunnel-restore: profile name (required for remote)
  --help, -h                this help

EXIT CODES
  0 success (including a dry-run preview), 1 error / apply partial failure
`.trim();
}

export function parseArgs(argv: string[], err: (s: string) => void): CliOpts | null {
  const opts: CliOpts = {
    mode: null,
    subcommand: null,
    dryRun: true,
    hasApplyFlag: false,
    confirm: false,
    includeSessions: false,
    strategy: 'merge',
    ackOverride: false,
    help: false,
  };

  const fail = (msg: string): CliOpts | null => {
    err(`[err] ${msg}`);
    return null;
  };

  // Subcommands come first (check-machines, tunnel-restore); the rest are flags.
  const rest = [...argv];
  if (rest.length > 0 && (rest[0] === 'check-machines' || rest[0] === 'tunnel-restore' || rest[0] === 'set-peer-host')) {
    opts.subcommand = rest.shift() as 'check-machines' | 'tunnel-restore' | 'set-peer-host';
  }

  const takeValue = (a: string, i: number, flag: string): string | null => {
    const v = rest[i];
    if (!v || v.startsWith('-')) {
      fail(`${flag} requires a value`);
      return null;
    }
    return v;
  };

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--pull' || a === '--push' || a === '--bidirectional') {
      if (opts.mode) return fail('Specify only one of --pull, --push or --bidirectional');
      opts.mode = a === '--pull' ? 'pull' : a === '--push' ? 'push' : 'bidirectional';
    } else if (a === '--include-sessions') {
      opts.includeSessions = true;
    } else if (a === '--dry-run' || a === '-n') {
      opts.dryRun = true;
    } else if (a === '--apply') {
      opts.hasApplyFlag = true;
      opts.dryRun = false;
    } else if (a === '--confirm') {
      opts.confirm = true;
    } else if (a === '--preview-id') {
      const v = rest[++i];
      if (!v || v.startsWith('-')) return fail('--preview-id requires a value');
      opts.applyPreviewId = v;
    } else if (a.startsWith('--preview-id=')) {
      opts.applyPreviewId = a.slice('--preview-id='.length);
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--local-dsh' || a === '--localDsh') {
      const v = rest[++i];
      if (!v || v.startsWith('-')) return fail('--local-dsh requires a path value');
      opts.localDsh = v;
    } else if (a === '--remote') {
      const v = rest[++i];
      if (!v || v.startsWith('-')) return fail('--remote requires a host value');
      opts.remote = v;
    } else if (a.startsWith('--remote=')) {
      opts.remote = a.slice('--remote='.length);
    } else if (a === '--remote-dsh' || a === '--remoteDsh') {
      const v = rest[++i];
      if (!v || v.startsWith('-')) return fail('--remote-dsh requires a path value');
      opts.remoteDsh = v;
    } else if (a.startsWith('--remote-dsh=')) {
      opts.remoteDsh = a.slice('--remote-dsh='.length);
    } else if (a === '--backup-root' || a === '--backupRoot') {
      const v = rest[++i];
      if (!v || v.startsWith('-')) return fail('--backup-root requires a path value');
      opts.backupRoot = v;
    } else if (a === '--strategy') {
      const v = rest[++i];
      if (!v || (v !== 'merge' && v !== 'override')) return fail('--strategy must be merge or override');
      opts.strategy = v;
    } else if (a.startsWith('--strategy=')) {
      const v = a.slice('--strategy='.length);
      if (v !== 'merge' && v !== 'override') return fail('--strategy must be merge or override');
      opts.strategy = v;
    } else if (a === '--ack-override') {
      opts.ackOverride = true;
    } else if (a === '--from') {
      const v = rest[++i];
      if (!v || v.startsWith('-')) return fail('--from requires a value (a machine id)');
      opts.from = v;
    } else if (a.startsWith('--from=')) {
      opts.from = a.slice('--from='.length);
    } else if (a === '--to') {
      const v = rest[++i];
      if (!v || v.startsWith('-')) return fail('--to requires a value (a machine id)');
      opts.to = v;
    } else if (a.startsWith('--to=')) {
      opts.to = a.slice('--to='.length);
    } else if (a === '--side') {
      const v = rest[++i];
      if (!v || v.startsWith('-')) return fail('--side requires local or remote');
      opts.side = v;
    } else if (a.startsWith('--side=')) {
      opts.side = a.slice('--side='.length);
    } else if (a === '--host') {
      const v = rest[++i];
      // A host, never a flag: `user@host` and bare hostnames are both legal.
      if (!v || v.startsWith('--')) return fail('--host requires a value');
      opts.peerHost = v;
    } else if (a.startsWith('--host=')) {
      opts.peerHost = a.slice('--host='.length);
    } else if (a === '--clear') {
      opts.clearPeer = true;
    } else if (a === '--profile') {
      const v = rest[++i];
      if (!v || v.startsWith('-')) return fail('--profile requires a value');
      opts.profile = v;
    } else if (a.startsWith('--profile=')) {
      opts.profile = a.slice('--profile='.length);
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
  if (opts.mode === 'bidirectional' && opts.strategy === 'override') {
    return fail('--bidirectional requires the merge strategy (override is a one-direction destructive mirror)');
  }
  if (opts.from !== undefined && !isMachineId(opts.from)) return fail('--from must be a machine id (letters, digits, . _ -)');
  if (opts.to !== undefined && !isMachineId(opts.to)) return fail('--to must be a machine id (letters, digits, . _ -)');
  if (opts.subcommand === 'set-peer-host') {
    if (opts.mode) return fail('set-peer-host takes no --pull/--push/--bidirectional flag');
    if (opts.clearPeer === true && opts.peerHost !== undefined) return fail('set-peer-host takes either --host or --clear, not both');
    if (opts.clearPeer !== true && !opts.peerHost) return fail('set-peer-host requires --host <host> or --clear');
  }
  if (opts.subcommand === 'tunnel-restore') {
    if (opts.mode) return fail('tunnel-restore takes no --pull/--push/--bidirectional flag');
    const side = opts.side ?? 'local';
    if (side !== 'local' && side !== 'remote') return fail('--side must be local or remote');
    if (opts.confirm !== true) return fail('tunnel-restore requires --confirm');
    if (side === 'remote' && !opts.profile) return fail('tunnel-restore --side remote requires --profile <name>');
  }
  if (opts.hasApplyFlag) {
    if (!opts.applyPreviewId) return fail('--apply requires --preview-id <id> from a previous --dry-run preview');
    if (opts.confirm !== true) return fail('--apply requires --confirm');
  }
  return opts;
}

async function runBidirectional(
  svc: SyncService,
  opts: CliOpts,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const scope: SyncScope = opts.includeSessions ? 'all' : 'memory';
  if (opts.hasApplyFlag) {
    err(`[sync] apply bidirectional preview ${opts.applyPreviewId} (scope ${scope})`);
    let result;
    try {
      result = await runBidirectionalApply(svc, { previewId: opts.applyPreviewId!, confirm: true, scope });
    } catch (e: any) {
      out(JSON.stringify({ ok: false, error: e?.message ?? String(e), code: e?.code, phase: e?.phase }) + '\n');
      err(`[err] bidirectional apply failed: ${e?.message ?? String(e)}`);
      return 1;
    }
    out(JSON.stringify({ ok: result.ok, push: result.push, pull: result.pull, verification: result.verification, committed: result.committed, failures: result.failures }) + '\n');
    if (!result.ok) {
      err(`[err] bidirectional partially failed: ${result.failures.map((f: any) => f.path ?? f.code).join(',')}`);
      return 1;
    }
    err(`[sync] bidirectional applied: committed ${result.committed.length}, failures ${result.failures.length}`);
    return 0;
  }

  // default: dry-run combined preview (read-only). The pull plan is projected:
  // it is recomputed exact after the push lands at apply time.
  err(`[sync] preview bidirectional (dry-run, scope ${scope})`);
  let combined;
  try {
    combined = await runBidirectionalPreview(svc, { scope });
  } catch (e: any) {
    out(JSON.stringify({ ok: false, error: e?.message ?? String(e), code: e?.code, phase: e?.phase }) + '\n');
    err(`[err] bidirectional preview failed: ${e?.message ?? String(e)}`);
    return 1;
  }
  out(
    JSON.stringify({
      ok: true,
      previewId: combined.previewId,
      expiresAt: combined.expiresAt,
      push: { summary: combined.push.summary, actions: combined.push.actions },
      pullProjected: { summary: combined.pullProjected.summary, actions: combined.pullProjected.actions },
      note: 'pull plan is projected; recomputed exact at apply time',
    }) + '\n',
  );
  err(`[sync] bidirectional preview ${combined.previewId}: push merged=${combined.push.summary.merged} copied=${combined.push.summary.copied} / pull merged=${combined.pullProjected.summary.merged} copied=${combined.pullProjected.summary.copied}`);
  return 0;
}

/** Resolve a `~/.dsh`-style placeholder to an absolute remote path (read-only preflight). */
async function resolveAbsoluteRemoteDsh(transport: SshRsyncTransport, host: string, remoteDsh: string): Promise<string> {
  if (remoteDsh !== '~/.dsh' && !remoteDsh.startsWith('~/')) return remoteDsh;
  const home = await transport.remoteHome({ host });
  return home + remoteDsh.slice(1);
}

/** Default remote machine-id read: agent op over the existing ssh transport (no new binary). */
async function defaultReadRemoteId(host: string, remoteDsh: string): Promise<string | null> {
  try {
    const transport = new SshRsyncTransport(new NodeProcessRunner());
    const root = await resolveAbsoluteRemoteDsh(transport, host, remoteDsh);
    return await transport.readMachineId({ host, dshRoot: root });
  } catch {
    return null;
  }
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
  if (!opts.mode && !opts.subcommand) {
    err('[err] Missing required --pull, --push, --bidirectional, check-machines or tunnel-restore (see --help)');
    return 1;
  }

  const resolvedLocalDsh = opts.localDsh ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  let cfg: SyncConfig;
  try {
    cfg = await loadSyncConfig({ dshHome: resolvedLocalDsh });
  } catch {
    cfg = { remoteHost: process.env.REMOTE_HOST || DEFAULT_REMOTE_HOST, remoteDshPath: '~/.dsh', strategy: 'merge' };
  }
  const resolvedRemote = opts.remote ?? cfg.remoteHost;
  try {
    validateHost(resolvedRemote);
  } catch (e: any) {
    err(`[err] invalid --remote host: ${e?.message ?? String(e)}`);
    return 1;
  }
  const resolvedRemoteDsh = opts.remoteDsh ?? cfg.remoteDshPath;

  // Machine identity: resolved before any service/preview/apply work.
  const readLocal = deps.identity?.readLocal ?? ((home: string) => readLocalMachineId(undefined, home));
  const readRemote = deps.identity?.readRemote ?? defaultReadRemoteId;
  /**
   * --from/--to, defaulted from the ids actually read off the two machines
   * (`$DSH_HOME/machine-id`); an underivable peer is an error, never a guess.
   */
  const resolveMachines = (
    localId: string | null,
    remoteId: string | null,
    o: { from?: string; to?: string },
  ): { from: string; to: string } | { error: string } => {
    const from = o.from ?? localId ?? undefined;
    if (from === undefined) return { error: 'cannot read the local machine-id — pass --from <id>' };
    const to = o.to ?? peerMachineId(from, localId, remoteId) ?? undefined;
    if (to === undefined) return { error: 'cannot derive --to from the machine ids — pass --to <id>' };
    return { from, to };
  };

  if (opts.subcommand === 'check-machines') {
    const mode: MachineMode = opts.mode ?? 'bidirectional';
    const localId = await readLocal(resolvedLocalDsh);
    const remoteId = await readRemote(resolvedRemote, resolvedRemoteDsh);
    const machines = resolveMachines(localId, remoteId, opts);
    if ('error' in machines) {
      err(`[err] ${machines.error}\n`);
      return 1;
    }
    const { from, to } = machines;
    const verdict = checkMachines({ mode, from, to, localId, remoteId });
    if (!verdict.ok) {
      out(JSON.stringify({ ok: false, code: verdict.code, error: verdict.message, localId, remoteId, from, to }) + '\n');
      err(`[err] ${verdict.message}`);
      return 1;
    }
    out(JSON.stringify({ ok: true, mode, localId, remoteId, from, to }) + '\n');
    err(`[sync] machines ok: local=${localId ?? 'unknown'} remote=${remoteId ?? 'unknown'} from=${from} to=${to}`);
    return 0;
  }

  if (opts.subcommand === 'tunnel-restore') {
    const side = opts.side ?? 'local';
    if (side === 'local') {
      err(`[sync] tunnel-restore local (profile ${opts.profile ?? 'auto'})`);
      const r = await restoreLocalTunnel({ dshHome: resolvedLocalDsh, profileName: opts.profile });
      out(JSON.stringify({ ok: r.ok, side, ...(r.ok ? { profile: r.profile } : { code: r.code }) }) + '\n');
      if (!r.ok) {
        err('[err] tunnel-restore local: no profile found');
        return 1;
      }
      err(`[sync] tunnel restored from profile ${r.profile}`);
      return 0;
    }
    // remote: explicit profile required (validated in parseArgs); caller ensures the agent.
    err(`[sync] tunnel-restore remote (profile ${opts.profile})`);
    try {
      const runner = new NodeProcessRunner();
      const transport = new SshRsyncTransport(runner);
      await transport.ensureAgent({ host: resolvedRemote, dshRoot: await resolveAbsoluteRemoteDsh(transport, resolvedRemote, resolvedRemoteDsh) });
      const r = await restoreRemoteTunnel(transport, { host: resolvedRemote, dshRoot: await resolveAbsoluteRemoteDsh(transport, resolvedRemote, resolvedRemoteDsh) }, opts.profile!);
      if (!r.ok) {
        out(JSON.stringify({ ok: false, side, code: r.code }) + '\n');
        err(`[err] tunnel-restore remote: ${r.code}`);
        return 1;
      }
      out(JSON.stringify({ ok: true, side, profile: r.profile, changed: r.changed, sha256: r.sha256 }) + '\n');
      err(`[sync] tunnel restored on remote from profile ${r.profile} (changed=${r.changed})`);
      return 0;
    } catch (e: any) {
      out(JSON.stringify({ ok: false, side, error: e?.message ?? String(e), code: e?.code }) + '\n');
      err(`[err] tunnel-restore remote failed: ${e?.message ?? String(e)}`);
      return 1;
    }
  }

  if (opts.subcommand === 'set-peer-host') {
    try {
      if (opts.clearPeer === true) {
        const removed = clearPeerHost(resolvedLocalDsh);
        out(JSON.stringify({ ok: true, action: 'clear', removed, dshHome: resolvedLocalDsh }) + '\n');
        err(`[sync] machine-local peer cleared (${removed ? 'removed' : 'nothing to remove'})`);
      } else {
        const host = writePeerHost(resolvedLocalDsh, opts.peerHost!);
        out(JSON.stringify({ ok: true, action: 'set', remoteHost: host, dshHome: resolvedLocalDsh }) + '\n');
        err(`[sync] this machine's peer recorded: ${host}`);
      }
      return 0;
    } catch (e: any) {
      out(JSON.stringify({ ok: false, error: e?.message ?? String(e) }) + '\n');
      err(`[err] set-peer-host failed: ${e?.message ?? String(e)}`);
      return 1;
    }
  }

  // Mode flows: enforce identity before constructing the service.
  // (Subcommands return above, so a mode is always present here.)
  if (!opts.mode) {
    err('[err] Missing required --pull, --push or --bidirectional (see --help)');
    return 1;
  }
  {
    const mode: MachineMode = opts.mode;
    const localId = await readLocal(resolvedLocalDsh);
    const remoteId = await readRemote(resolvedRemote, resolvedRemoteDsh);
    const machines = resolveMachines(localId, remoteId, opts);
    if ('error' in machines) {
      err(`[err] ${machines.error}\n`);
      return 1;
    }
    const { from, to } = machines;
    const verdict = checkMachines({ mode, from, to, localId, remoteId });
    if (!verdict.ok) {
      err(`[err] ${verdict.message}`);
      return 1;
    }
  }

  let svc: SyncService;
  if (deps.makeService) {
    svc = await deps.makeService({ ...cfg, remoteHost: resolvedRemote, remoteDshPath: resolvedRemoteDsh, strategy: opts.strategy });
  } else {
    svc = new SyncService({ localDsh: resolvedLocalDsh, remote: resolvedRemote, remoteDsh: resolvedRemoteDsh });
  }

  if (opts.mode === 'bidirectional') {
    return runBidirectional(svc, opts, out, err);
  }
  const direction: SyncDirection = opts.mode;

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