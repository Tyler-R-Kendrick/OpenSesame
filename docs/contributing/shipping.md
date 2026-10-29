# Starting, parallelizing, and shipping a task — full procedure

Full procedure moved from `AGENTS.md` §9. `AGENTS.md` §9 keeps the generic sequence. Machine-specific paths, personal identities, and transient checkout names from the original text have been replaced with placeholders.

## 9. Starting, parallelizing, and shipping a task

Every new goal follows this sequence. It applies to interactive sessions and
to the standing routines in `ops/routines/` (`docs/contributing/agent-routines.md`).

### Worktree

Fetch `origin/main`, then:

```bash
```

`git worktree` shares this clone's object database. Do not `git clone` a
second full copy of the repository, and do not nest the worktree inside
`<worktree>` or commit it as files of that checkout. Leave
a checkout with `MERGE_HEAD` set alone: do not commit, abort, or finish that
merge to make room for the task. One task, one branch stack. Leave unrelated

### Shared caches

The disk stays near full. A new worktree gets source only.

- pnpm: install with the existing store (`pnpm store path`, the user store
  under `~/.local/share/pnpm/store`). `pnpm install` hardlinks from that
  store. Do not copy `node_modules` from another checkout.
- Cargo: `CARGO_TARGET_DIR=$HOME/.cache/packages/cargo-target` on every
  `cargo` and `cargo +1.88.0` invocation, in every worktree. Do not create a
  per-worktree `target/`.
- Playwright browsers stay in the existing browser cache. Do not download a
  second browser pack for a worktree.
- Skip `pnpm install` and Rust builds unless the task's checks need them.

### Swarm

Independent slices run together as a workflow. The standing entry point is
a task-specific script when the slices are fixed). Each slice is one agent
with a self-contained prompt and a disjoint set of files. Agents write only
inside the task worktree. The parent integrates, reviews, and is the only
one who opens pull requests.

### Incremental commits and stacked pull requests

One logical slice per commit. A multi-slice task is a stack: the first pull
request targets `main`, and each next pull request targets the previous
branch.

Only the bottom of a stack runs CI. Open every pull request above it as a
draft: a draft runs no suite, and the three required checks fail on it by
design so a draft's head SHA can never read green. Mark a pull request ready
for review (`ready_for_review` starts CI) only once the one below has merged
and you have restacked it. Push at checkpoints, not per file: each push to an
open, non-draft pull request restarts CI.

Commits are created with GitHub's GraphQL `createCommitOnBranch` so the
committer is GitHub and the ruleset sees a verified signature. A local
`git commit`, including an SSH signature from `<signing-key>`,
is `unknown_key` and cannot merge. Omit an author override on the mutation.
`expectedHeadOid` is `origin/main` for the first commit and the previous
commit on the stack after that. The local git identity, when a tool needs

### After each commit

Run `df -h /`. Delete scratch under `/tmp` that this commit created, and any
build output that exists only because of that commit. Leave
worktrees, and the primary checkout's uncommitted work in place. Remove a
task worktree only after its branch has been squash-merged and its remote
branch deleted (`git worktree remove`, then `git worktree prune`).

### Done

When every pull request in the stack is open:

1. Self-review the diff and post that review on each pull request. Resolve
   every review thread opened on the stack.
2. A Copilot review request on this repository returns HTTP 422. CodeRabbit
   does not auto-review while the repository has fewer than 10 stars. The
   self-review is the review that has to land.
3. Squash-merge only after the required checks are green and the pull request
   is up to date with `main`: TypeScript, Rust, and Bundle budgets. The
   ruleset is squash-only. Do not pass `--admin`.
4. Merge from the bottom of the stack. After each squash, restack the next
   branch onto the new `main` with another verified `createCommitOnBranch`
   (full file contents of that slice, `expectedHeadOid` the new main tip)
   and squash-merge it the same way.
5. Remove the finished worktree and delete the local and remote branches.

User-visible product changes still follow §5 visual evidence and §8 gates.
This section is how the work is hosted. It does not waive those gates.

### Local task queue

`ops/routines/*.md` and `docs/contributing/agent-routines.md` are the local
task queue. Each routine starts with this same worktree, shared-cache, swarm,
stack, disk-check, and squash-merge sequence. A routine that edits the tree
