# Repository governance

This personal-account public repository requires an up-to-date pull request on
its default branch. It has no merge queue: GitHub does not support queues for
this repository configuration. CODEOWNERS routes review without requiring the
sole owner to approve their own PR. Resolved review threads, signed commits,
squash-only linear history, blocked force pushes/deletion and all three named
Actions checks remain required, with no bypass actors. GitHub Actions (app ID
15368) must report the checks; a third-party status with the same name cannot
satisfy them.

Copilot review can be requested as an additional independent analysis, but it
does not supply a second human maintainer or automatically satisfy an approval
requirement. Add a real eligible reviewer before enabling mandatory approvals;
do not lock the sole maintainer out or fabricate approval records.

A second ruleset, `opensesame-release-tags` (`release-tags.json`), protects
release version reservations: only a repository admin may create, move or delete
`v*` tags. The trusted main controller stages a tag naming the qualified candidate
before publication and rechecks its target. Tag protection remains separate from
the `release` environment: scheduled promotion executes on `main`, not the tag.
The admin role is the tag ruleset's one bypass actor. `--apply` writes that
ruleset; `--verify` fails until it is in place.

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
creates/updates the two named rulesets, preserves unrelated rulesets, enables
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
