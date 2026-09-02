# dsh-maestro-sync

Maestro harness sync — merge memories and sessions across machines (publishable)

> DSH Maestro plugin — part of the `dsh-maestro-*` ecosystem (`@ddtcorex/dsh-maestro-sync`).

## Install

```sh
dsh plugin add @ddtcorex/dsh-maestro-sync
```

## Safe Sync — Preview then Apply

Sync is **exact, read-only preview first, then confirmed apply**:

```sh
# 1. Preview (read-only, no writes, 60s TTL) — the only way to see a plan
node lib/cli.js --pull --dry-run      # or --push --dry-run
# stdout: one final JSON SyncPreview { ok, previewId, revision, expiresAt, summary, actions }
# human progress goes to stderr

# 2. Apply the EXACT preview you just reviewed (requires all three)
node lib/cli.js --pull --apply --preview-id <id> --confirm
```

- **No omitted boolean can apply a sync.** `--apply` without `--preview-id` and
  `--confirm` exits non-zero; the legacy `pull`/`push` routes and tools are
  preview-only compatibility aliases and never write.
- **Stale-guard:** apply re-inventories both machines, recomputes the plan and
  rejects it as `STALE_PREVIEW` if anything changed since the preview — no write
  happens against a stale plan. Apply is single-use per preview id.
- **Eligible only:** `memories/**/*.md` (no `*.bak.*`), `memories/SUGGESTIONS.jsonl`, `sessions/<hash>/<id>/session.jsonl.zstd`
- **Transport:** argv-only `spawn`/`rsync --files-from`, no shell interpolation;
  the remote root is a validated absolute path. A `~/.dsh` default is resolved
  to the absolute remote home by the SSH preflight (`printf %s '$HOME'`), never
  by shell `~` expansion.
- **Sessions:** `Buffer`/`path` only via validated Zstd artifact API; the
  standalone checksummed header frame is preserved and merged line-union.
- **Atomic publish:** pull = `backup + fsync(tmp) + rename + fsync(dir)` per
  local file; push = materialize to a private operation dir, upload to
  `<root>/.maestro-sync/stage/<op>/`, then a fixed POSIX CAS helper validates
  each target SHA-256 (`expectedTargetSha256`), backs up and renames atomically.
  A concurrent remote change is reported as `CONCURRENT_MODIFICATION` and never
  overwrites the target.
- **Fail closed:** a transport/stage/publish failure is a structured non-zero
  result with `committed`/`uncommitted` journals — `ok:true` only when every
  reported file was actually published. No merge-mode fallback to destructive
  rsync; `--strategy=override` exists only with a separate `--ack-override`.
- **Recovery:** every overwritten file keeps a timestamped backup beside it
  (`.bak.<ts>.<rand>`; remote backups under the same rule). Restore with
  `cp <path>.bak.* <path>`.
- **Consent:** live Apply is an operator action — the CLI requires
  `--preview-id` + `--confirm`; the Settings UI only offers Apply inside a
  confirmation dialog bound to a live preview.
- **Host preflight:** `ssh -o ConnectTimeout=5` must succeed before preview/apply.
- **UI:** Settings -> Maestro Sync -> *Preview Pull/Push* -> review
  `copy`/`merge`/`skip`/`conflict` -> confirmation dialog (direction, host,
  plan age, action counts) -> *Apply*.

Excluded (never read, hashed or copied): settings, tunnel profiles, secret
material, profiles, supervisor state, storages, tools, skills, logs, caches and
`*.bak.*`.

## R2 Sync — offsite backup (Cloudflare R2; AWS S3 via the same client, UI hidden)

Backup and restore of the eligible data (memories + session logs) to an
S3-compatible bucket through a dependency-free SigV4 client.

- **Config** (`~/.dsh/maestro/settings.json` → `domains.sync.r2`): `accountId`,
  `bucket` (default `maestro-backup`), `prefix`, `region`; optional
  `provider: "aws"` with a real region works through the same client (UI
  hidden in phase 1).
- **Secret material**: environment (`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`,
  AWS `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) or a private `0600` sidecar
  file in the plugin's own runtime dir — never in settings, never logged,
  never returned by RPC/tools (status shows only `Env | Private file | Not
  configured` and the bucket/prefix).
- **Preview Backup** is read-only: it compares current eligible hashes against
  the last manifest in the bucket (no object transfer). **Apply** is the only
  upload route: it PUTs missing blobs (content-addressed, idempotent), writes
  an immutable manifest and CAS-advances the `HEAD` pointer; `ok` is reported
  only after `HEAD` advances (`CONCURRENT_MODIFICATION` on a race).
- **Restore**: to a new directory (never touches the live home) or in place
  (each overwritten target keeps a `.bak.<ts>.<rand>`, `fsync+rename`), both
  confirmation-first. **GC**: retains the newest 30 daily + 12 monthly
  manifests and deletes only unreachable blobs, confirmation-first.
- Live R2 conditional-write behavior is pinned by an operator-consent probe
  after the phase-3 hermetic fake-S3 gate — no R2 account is needed to build
  or test this feature.

## Develop

```sh
pnpm --filter @ddtcorex/dsh-maestro-sync verify
pnpm --filter @ddtcorex/dsh-maestro-sync build
pnpm --filter @ddtcorex/dsh-maestro-sync test
```
