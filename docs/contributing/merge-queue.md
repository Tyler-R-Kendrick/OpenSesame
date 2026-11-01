# Merge queue

OpenSesame lives in the public [OpenSesame-Labs](https://github.com/OpenSesame-Labs)
organization. The default branch uses GitHub's **native merge queue** (not a
third-party app).

## What you do

1. Open a pull request against `main` with signed commits and the required CI
   checks green on the PR head.
2. Resolve every review thread.
3. Add the pull request to the merge queue from the GitHub UI (or enable
   auto-merge into the queue when checks pass).

The queue squash-merges one entry at a time (or in configured batches) onto
`main`. You do not need a strictly up-to-date PR branch before queueing: the
queue builds a temporary commit and runs the same required checks again.

## What CI must do

The workflow in `.github/workflows/ci.yml` listens for `merge_group` as well as
`pull_request`. The three gate jobs must report the same check names on both
events:

- TypeScript
- Bundle budgets
- Rust

If `merge_group` runs do not publish those names, queued pull requests stay
blocked forever.

Concurrency is configured so in-flight `merge_group` and `push` to `main` runs
are never cancelled when a newer pull request starts.

## Applying branch policy

The checked-in ruleset is `ops/github/default-branch.json`. A repository admin
applies it with:

```bash
node ops/github/governance.mjs --apply
node ops/github/governance.mjs --verify
```

See [repository governance](../../ops/github/README.md) for break-glass and
release-tag rulesets.
