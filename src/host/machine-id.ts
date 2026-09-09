import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import type { ProcessRunner } from './process-runner.js';

export type MachineMode = 'pull' | 'push' | 'bidirectional';

export interface MachineCheck {
  mode: MachineMode;
  from: string;
  to: string;
  localId: string | null;
  remoteId: string | null;
}

export type MachineVerdict =
  | { ok: true; localId: string | null; remoteId: string | null }
  | { ok: false; code: 'WRONG_MACHINE'; message: string };

export async function readLocalMachineId(fsMod: any = nodeFs, dshHome?: string): Promise<string | null> {
  try {
    const home = dshHome ?? process.env.DSH_HOME ?? '';
    if (!home) return null;
    const raw = typeof fsMod.readFileSync === 'function' ? fsMod.readFileSync(path.join(home, 'machine-id'), 'utf-8') : null;
    const id = String(raw ?? '').trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function readRemoteMachineId(runner: ProcessRunner, host: string, remoteDsh: string): Promise<string | null> {
  try {
    const r = await (runner as any).run('ssh', [host, 'cat', `${remoteDsh}/machine-id`], { timeoutMs: 8000 });
    if (r.exitCode !== 0) return null;
    const id = Buffer.concat([r.stdout]).toString('utf-8').trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function checkMachines(c: MachineCheck): MachineVerdict {
  if (c.from === c.to) {
    return { ok: false, code: 'WRONG_MACHINE', message: `[wrong-machine] --from (${c.from}) equals --to (${c.to}); refusing` };
  }
  const known = (v: string | null): v is string => typeof v === 'string' && v.length > 0;
  if (c.mode === 'pull' && known(c.remoteId) && c.from !== c.remoteId) {
    return { ok: false, code: 'WRONG_MACHINE', message: `[wrong-machine] --pull with --from=${c.from} but remote reports ${c.remoteId}; re-run with --from=${c.remoteId} --to=${c.localId ?? c.to}` };
  }
  if (c.mode === 'push' && known(c.localId) && c.from !== c.localId) {
    return { ok: false, code: 'WRONG_MACHINE', message: `[wrong-machine] --push with --from=${c.from} but you are on ${c.localId}; re-run with --from=${c.localId} --to=${c.remoteId ?? c.to}` };
  }
  if (c.mode === 'bidirectional' && known(c.localId) && known(c.remoteId) && (c.from !== c.localId || c.to !== c.remoteId)) {
    return { ok: false, code: 'WRONG_MACHINE', message: `[wrong-machine] --bidirectional needs --from=${c.localId} --to=${c.remoteId} (invoke from the source side); re-run accordingly` };
  }
  return { ok: true, localId: c.localId, remoteId: c.remoteId };
}
