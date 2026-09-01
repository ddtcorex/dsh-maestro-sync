## Summary

Describe the change in 2–3 bullets.

## Why

Explain the problem this PR solves and why this approach was chosen.

## Changes

- [ ] Code / docs updated
- [ ] Tests added or updated (if behavior changed)
- [ ] Safety contract preserved (preview read-only, apply-only mutation, Buffer-only zstd, argv-only transport, fail-closed wrapper) — see `AGENTS.md`

## Validation

Paste exact commands and outcomes (do not claim verified without evidence):

```bash
pnpm verify
pnpm test
pnpm build
```

Additional checks when relevant:

```bash
bash -n scripts/sync-harness.sh          # workspace root
bash scripts/tests/sync-harness-sync-cli.test.sh   # workspace root
```

## Linked Issues

Fixes #

## Checklist

- [ ] Branch is `feat/…`, `fix/…`, `docs/…`, or `chore/…` off `master` (no direct commits to `master`)
- [ ] Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`) in imperative mood
- [ ] `pnpm verify` / `pnpm test` / `pnpm build` are green
- [ ] No private project/client names in code, docs, tests, or commit messages (public repo)