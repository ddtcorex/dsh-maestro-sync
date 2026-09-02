# AGENTS.md — dsh-maestro-sync

> `CLAUDE.md` at the repo root is a symlink to `AGENTS.md`. Claude Code follows the same rule set as Codex CLI. Only edit `AGENTS.md` — never edit `CLAUDE.md` directly or replace the symlink with a copy.

## Purpose

Safe machine-to-machine sync for DeepSeek Harness (DSH) state: merge `memories/`
(Markdown + `SUGGESTIONS.jsonl`) and `sessions/**/session.jsonl.zstd` across two
machines over `ssh`/`rsync`. One Cordis row (`id: dsh-maestro-sync`) with a host
half (Node CLI/RPC/tools) and a client half (Settings UI).

Names by boundary: npm package = `@ddtcorex/dsh-maestro-sync`; Cordis patch row id = `dsh-maestro-sync`.

Part of the Maestro Harness suite. **Opt-in plugin**: it is not installed by the
default web profile or the `dsh-maestro-meta` bundle — add it explicitly with
`dsh plugin add @ddtcorex/dsh-maestro-sync` (or a `link:` dependency in the
profile) when you want it.

## Safety contract (non-negotiable)

- **Preview is read-only and exact**: it stages remote eligible files once
  (argv-only `rsync --files-from`, checksum dry-run first) and reports
  `copy`/`merge`/`skip`/`conflict` with real added counts.
- **Apply is the freshest-inventory mutation route**: it re-inventories both
  sides, recomputes the plan and publishes it with per-file CAS (expected
  target SHA-256); a preview is single-use and expires after 60 s. Concurrent
  mid-write modification is rejected (`CONCURRENT_MODIFICATION`); global
  inventory-drift rejection was removed 2026-09-01 (`d9b2d33`) because a live
  DSH home changes every turn.
- **Bytes remain bytes**: `.jsonl.zstd` is staged/hashed/merged as Buffers
  through the validated Zstd artifact API (`session-plan.ts`, `session-merge.ts`)
  — never UTF-8-decoded. The standalone checksummed header frame is preserved.
- **No shell interpolation**: transport uses `spawn`/`execFile` argv arrays;
  the remote is a fixed POSIX CAS helper (`remote-agent.ts`) that validates each
  target SHA-256 and never overwrites on `CONCURRENT_MODIFICATION`.
- **Atomic**: pull publishes `backup + fsync(tmp) + rename + fsync(dir)` per
  file; push materializes below a private operation dir, uploads, then commits.
- **Fail closed**: a transport/publish failure is a structured non-zero result
  with committed/uncommitted journals; `ok:true` only when every reported file
  was actually published. The wrapper (`sync-harness.sh`) never falls back to
  destructive rsync when the CLI is missing/errors; `--strategy=override` needs
  `--ack-override`.
- **Eligible data only**: `memories/**/*.md` (no `*.bak.*`),
  `memories/SUGGESTIONS.jsonl`, `sessions/<hash>/<id>/session.jsonl.zstd`.
  Settings, profiles, tunnel artifacts, secret material, logs, caches, supervisor
  state are never read, hashed or copied.
- **Backup/restore/GC are the same preview→confirm contract** (spec
  2026-09-02-dsh-maestro-sync-speed-backup-design.md): backup preview is
  read-only (compare against the bucket HEAD manifest), apply is the only
  upload route (blobs → immutable manifest → CAS `HEAD`; `ok` only after HEAD
  advances), restore (new-dir or in-place with `.bak` + `fsync`/`rename`) and
  GC (retain 30 daily + 12 monthly, delete only unreachable blobs) are
  confirmation-first and single-use. Secret material comes from env or a
  private `0600` sidecar and is never persisted in settings or returned by
  RPC/tools.

## Layout

- `src/host/index.ts` — host `apply()`: registers the preview/apply/status tools
  and the `/dsh-maestro-sync` RPC channel (loopback authority).
- `src/host/cli.ts` — `node lib/cli.js --pull [--dry-run] | --apply --preview-id ID --confirm`.
- `src/host/sync-service.ts` — the service: snapshot, plan, apply, status pages.
- `src/host/transport.ts` — argv-only ssh/rsync transport; `compare`/`stage`/`upload`/`ensureAgent`/`commit`.
- `src/host/remote-agent.ts` — the fixed remote CAS helper source (POSIX sh).
- `src/host/sigv4.ts`, `s3-object-store.ts`, `backup-config.ts`,
  `backup-service.ts` — R2/S3 backup engine (zero-dep SigV4 + fetch), restore
  and retention GC; hermetic fake used in tests (`tests/helpers/fake-s3.ts`).
- `src/host/sync-plan.ts`, `validation.ts`, `snapshot.ts`, `merge.ts`,
  `session-plan.ts`, `session-merge.ts`, `process-runner.ts`, `config.ts`, `sync-types.ts`.
- `src/client/index.tsx` — Settings section (confirmation-first Preview/Apply UI).
- `lib/` — committed build output. Generated; do not hand-edit.
- `tests/*.spec.ts` — vitest suites (18 files, 104 tests), incl. `hermetic-rehearsal.spec.ts`.

## Development

Run from the repository root:

```sh
pnpm verify   # tsc --noEmit host + client
pnpm test     # NODE_ENV=test vitest run
pnpm build    # tsc host + tsc client && node scripts/build-client.mjs -> lib/
```

`pnpm build` is the required gate after any source change; `lib/` is committed,
so a change is incomplete until the build refreshes it. The test script forces
`NODE_ENV=test` because an ambient `NODE_ENV=production` shell breaks the
jsdom/react client tests.

## Git workflow

- Default branch `master`. No direct commits to `master` — use `feat/<topic>` /
  `fix/<topic>` / `chore/<topic>` and a PR against `ddtcorex/dsh-maestro-sync`.
- Conventional commits, imperative mood. One TDD task = one commit; never
  commit while `pnpm verify` is red. When the base moves, rebase onto
  `origin/master` (single-origin workflow).

## Conventions

- Keep the strict host/client split; client bundle injects
  `['@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-client-ui-slots']`.
- Remote roots are validated absolute paths (`validation.ts`); a `~/.dsh`
  default is resolved by the SSH preflight, never shell `~` expansion.
- `status` never implies same path = same content; it pages with cursors and
  stays under 64 KiB per response.
- Strict TDD with vitest; every deterministic operation is a tool/API, the LLM
  is reasoning-only.

## Validation

- `pnpm verify` + `pnpm test` green before any success claim.
- CAS semantics are pinned by `tests/sync-apply.spec.ts` and
  `tests/remote-agent.spec.ts` (the sh helper is executed for real).
- After touching the client bundle: `pnpm build` then verify on live DSH Web
  (`:3080`), not just curl/grep. The workspace `sync-harness.sh` merge tier
  must keep `bash -n` clean and
  `scripts/tests/sync-harness-sync-cli.test.sh` green.

## See Also

- Safety design: `docs/specs/2026-08-31-dsh-maestro-sync-remediation-design.md`
  (workspace root). Live Apply on either machine, `dsh web` restarts and
  releases require explicit human approval.
- Always request approval before merge or release — never merge a PR/MR or
  publish a release without an explicit human approval.