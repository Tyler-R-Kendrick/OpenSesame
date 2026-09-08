# Repository governance

This personal-account public repository uses required, up-to-date PR checks,
not a merge queue. The policy routes review with CODEOWNERS without requiring
the sole owner to approve their own PR. It requires resolved review threads,
signed commits, squash-only linear history, and blocks force pushes/deletion.
There are no bypass actors. GitHub Actions (app ID 15368) must report the three
named checks; a third-party status with the same name cannot satisfy them.

```sh
node ops/github/governance.mjs --dry-run
node ops/github/governance.mjs --apply
node ops/github/governance.mjs --verify
```

Dry-run reads live state and prints the proposed changes; it writes nothing.
Apply requires repository-administration and environment permissions. It only
creates/updates the named ruleset, preserves unrelated rulesets, enables
auto-merge, and restricts the existing github-pages environment to the current
default branch. Non-default branch/tag environment policies (including the
legacy gh-pages branch) are removed: manual deployment from them no longer
works. Existing environment reviewers/wait timers are preserved. A failed API
call fails the command; neither a checked-in spec nor a dry-run proves active
protection. Verification queries the resulting ruleset, branch and environment.

Break glass requires the owner to deliberately change the named ruleset using
GitHub administration, record the reason privately, and restore/verify it after
recovery. There is no always-on bypass. Do not disable checks just to merge a
failing PR. GitHub-squashed commits are signed by GitHub; direct local commits
must meet the repository's signature requirements if they reach main.

Actions pins were resolved from each upstream repository's existing major tag
using the GitHub commits API. The hermetic regression in
`scripts/lib/github-governance.test.mjs` runs under the existing quality job and
rejects unpinned actions and retained checkout credentials. It does not assert
that pinned third-party code is trustworthy or that branch policy fixes runtime
authorization defects. Full audits and model reviews remain private/local.
