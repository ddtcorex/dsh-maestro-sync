# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-02

### Added

- **Manifest-first sync speed** — single-pass remote manifest (`stat` + awk getline cache), stat-keyed fingerprint cache (`fp.tsv` atomic via tmp+mv), SSH multiplexing (`openSshMux`, `rsync -e ssh -S`), bounded streaming SHA-256 pool and lazy content hashing; warm preview ~2–4s, cold ~10–20s (was 17–23s).
- **Cloudflare R2 / AWS S3 backup** — content-addressed blobs (`blobs/sha256/<sha>`) + immutable manifests + CAS HEAD (`HEAD` single-use, fail-closed), SigV4, S3ObjectStore (SigV4+fetch, path-style), backup preview/apply, restore (new-dir and in-place with .bak+fsync+rename), GC preview/apply (keepDaily 30, keepMonthly 12), 6 tools + RPC (`backupPreview/backupApply/restorePreview/restoreApply/backupGcPreview/backupGcApply`).
- **Two-tab Settings UI** — `Remote Sync` / `R2 Sync` tab switcher (`sync-tab-r2`/`sync-tab-remote`), R2 panel with backup/restore/GC flows, preserved remote preview/apply.

