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
# 1. Preview (read-only, no writes, 60s TTL)
node lib/cli.js --pull --dry-run   # or --push --dry-run
# Preview prints SyncPreview { previewId, expiresAt, revision, actions, summary }

# 2. Apply (requires previewId+direction+confirm:true)
node lib/cli.js --pull --preview-id <id> --confirm
```

- **Eligible only:** `memories/**/*.md` (no `*.bak.*`), `memories/SUGGESTIONS.jsonl`, `sessions/<hash>/<id>/session.jsonl.zstd`
- **Transport:** argv-only `spawn`/`rsync --files-from`, no shell interpolation; remote root is validated absolute path
- **Sessions:** `Buffer`/`path` only via validated Zstd artifact API, header frame preserved with checksum
- **Atomic publish:** per-file `backup + fsync(tmp) + rename + fsync(dir)`; partial failures return non-zero with `committed`/`uncommitted` journals
- **Host preflight:** `ssh` checks remote host is reachable before preview/apply
- **UI:** Settings -> Maestro Sync -> *Preview Pull/Push* -> review `copy`/`merge`/`skip`/`conflict` -> *Apply* (shows `previewId` prefix, expiry, host, action counts)

Excluded: settings, tunnel profiles, credentials, profiles, storages, tools, skills, supervisor, logs, node_modules.

## Develop

```sh
pnpm --filter @ddtcorex/dsh-maestro-sync verify
pnpm --filter @ddtcorex/dsh-maestro-sync build
pnpm --filter @ddtcorex/dsh-maestro-sync test
```
