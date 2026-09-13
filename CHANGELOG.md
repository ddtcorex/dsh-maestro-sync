# Changelog

## [0.3.1] - 2026-09-13

### Fixed

- **Machine ids are data, not a fixed pair of names** — `--from/--to` were
  validated against two hard-coded ids and the peer came from a name table, so
  only those two worked and the public repo carried private hostnames. The
  Release workflow's leak guard rejects those names, which killed the `v0.3.0`
  tag before the publish step; `0.3.1` carries the same changes as `0.3.0` plus
  this fix. Ids now come from each side's `machine-id` file: any stable
  identifier is accepted, the peer is derived from the ids actually read, and an
  underivable side fails closed instead of defaulting to a name.

## [0.3.0] - 2026-09-13

### Added

- Self-contained sync lifecycle, no external scripts (#16).
- One-shot bidirectional push-then-pull (#15).
- Mobile-first settings redesign (#13).

### Fixed

- Declare row `inject` for DSH 0.1.5 (#19).
- Restore the tunnel identity into the moved shared store (#18).
- Surface machines-check failures inline instead of hiding the line (#17).
- Point the eligible memory root at `dsh-maestro-memory` (#14).

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-02

### Added

- **Manifest-first sync speed** — single-pass remote manifest (`stat` + awk getline cache), stat-keyed fingerprint cache (`fp.tsv` atomic via tmp+mv), SSH multiplexing (`openSshMux`, `rsync -e ssh -S`), bounded streaming SHA-256 pool and lazy content hashing; warm preview ~2–4s, cold ~10–20s (was 17–23s).
- **Cloudflare R2 / AWS S3 backup** — content-addressed blobs (`blobs/sha256/<sha>`) + immutable manifests + CAS HEAD (`HEAD` single-use, fail-closed), SigV4, S3ObjectStore (SigV4+fetch, path-style), backup preview/apply, restore (new-dir and in-place with .bak+fsync+rename), GC preview/apply (keepDaily 30, keepMonthly 12), 6 tools + RPC (`backupPreview/backupApply/restorePreview/restoreApply/backupGcPreview/backupGcApply`).
- **Two-tab Settings UI** — `Remote Sync` / `R2 Sync` tab switcher (`sync-tab-r2`/`sync-tab-remote`), R2 panel with backup/restore/GC flows, preserved remote preview/apply.

