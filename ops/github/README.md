# Repository governance

This public organization repository merges through GitHub's native merge queue on
the default branch. "Require branch up to date" is off — the queue rebuilds each
entry against the tip of `main`. CODEOWNERS routes review without requiring the
sole owner to approve their own PR. Resolved review threads, signed commits,
squash-only linear history, blocked force pushes/deletion and all three named
Actions checks remain required, with no bypass actors. GitHub Actions (app ID
15368) must report `TypeScript`, `Bundle budgets`, and `Rust` on both
`pull_request` and `merge_group`; a third-party status with the same name cannot
satisfy them. See [merge queue](../docs/contributing/merge-queue.md).

Copilot review can be requested as an additional independent analysis, but it
does not supply a second human maintainer or automatically satisfy an approval
requirement. Add a real eligible reviewer before enabling mandatory approvals;
do not lock the sole maintainer out or fabricate approval records.

Two tag rulesets protect `refs/tags/v*` independently:

- `opensesame-release-tags` (`release-tags.json`) restricts updates and deletion
  to the repository admin (role 5). GitHub Actions has no mutation bypass.
- `opensesame-release-tag-creation` (`release-tag-creation.json`) restricts new
  tag creation to that admin and the GitHub Actions integration (app 15368).
  This lets the publisher reserve a tag naming the verified candidate using
  its job-scoped `GITHUB_TOKEN`, without receiving permission to move or delete
  an existing tag.

The creation exception identifies the Actions app, not one workflow. Any job
with repository contents-write permission could reserve a new version tag;
keep that permission narrowly scoped. The publisher independently validates
candidate/source identity and refuses occupied or moved tags. Tag restrictions
remain separate from the `release` environment: scheduled promotion executes
on `main`, not the tag. Main's ruleset receives no bypass actor.

`--apply` and `--verify` cover both named tag rulesets. On first activation,
apply bootstraps combined owner-only tag protection, installs the creation-only
exception, then removes creation from the original ruleset. During migration,
the original creation restriction remains until the new rule is installed.
Failure leaves the stronger restriction in place and verification fails. A
checked-in proposal or HTTP 403 is not activation: after an authorized admin
can apply settings, verify both live tag policies before release. GitHub documents that
[rulesets aggregate](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rule-layering),
that [creation, update and deletion restrictions require their own bypass](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
and that [`GITHUB_TOKEN` authenticates as a GitHub App installation](https://docs.github.com/en/actions/concepts/security/github_token),
not as the owner who initiated the run.

`release-environment.json` and `release-environment-branches.json` are the concrete
proposed settings for that environment, not evidence of applied protection.
They require the repository owner to approve a release, allow the sole owner to
approve a run they initiated, restrict deployment to the `main` branch and disable admin
bypass. The owner ID is this repository's public GitHub owner ID. Do not apply
them to another repository or overwrite an existing environment's reviewers
without review. Activation requires explicit authorization for these exact
protections and repository-administration plus environment access. Checked-in
files do not establish live protection. The release pipeline reads the live
environment and main-only branch policy with `actions: read` before staging or
publishing. Missing, unprotected, mismatched or unreadable settings block
promotion; the pipeline never auto-configures protection. Apply the reviewed
settings through an authorized administrator and rerun the existing checks. Some
integrations can read settings but cannot change them; an HTTP 403 must never be reported as a successful apply.

```sh
node ops/github/governance.mjs --dry-run
node ops/github/governance.mjs --apply
node ops/github/governance.mjs --verify
```

Dry-run reads live state and prints the proposed changes; it writes nothing.
Apply requires repository-administration and environment permissions. It only
creates/updates the three named rulesets, preserves unrelated rulesets, enables
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
