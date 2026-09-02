// bench-preview.mjs — dry-run preview benchmark for dsh-maestro-sync (no writes)
// Usage: node scripts/bench-preview.mjs --direction pull --rounds 3
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dsh = process.env.DSH_HOME || path.join(process.env.HOME, '.dsh');

function eligibleCounts() {
  let md = 0;
  let zstd = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (!['node_modules', '.git', '.supervisor', 'profiles'].includes(ent.name)) walk(full);
      } else if (ent.name.endsWith('.jsonl.zstd')) {
        zstd++;
      } else if (ent.name.endsWith('.md') && !ent.name.includes('.bak.')) {
        md++;
      }
    }
  };
  walk(path.join(dsh, 'memories'));
  walk(path.join(dsh, 'sessions'));
  return { md, zstd };
}

const args = process.argv.slice(2);
const direction = args.includes('--push') ? 'push' : 'pull';
const rounds = Number(args[args.indexOf('--rounds') + 1] || 3);
const cli = path.resolve('lib/cli.js');
const { md, zstd } = eligibleCounts();
const times = [];
for (let i = 0; i < rounds; i++) {
  const t0 = process.hrtime.bigint();
  const out = execFileSync('node', [cli, `--${direction}`, '--dry-run'], { stdio: ['ignore', 'pipe', 'inherit'] }).toString('utf-8');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  times.push(ms);
  const json = JSON.parse(out.trim().split('\n').pop());
  process.stdout.write(`round ${i + 1}: ${Math.round(ms)}ms copy=${json.summary?.copied ?? 0} merge=${json.summary?.merged ?? 0}\n`);
}
process.stdout.write(`BASELINE md=${md} zstd=${zstd} medianMs=${Math.round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)])}\n`);