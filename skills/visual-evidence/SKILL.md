---
name: visual-evidence
description: Compare screenshots from two real builds for any user-visible change, show the review evidence on the pull request, and persist only approved current-state artifacts in feature/project/platform slots.
---

# Visual evidence

Every user-visible change needs evidence a reviewer can inspect without building
and walking the app. Compare the base and branch builds using the same journey,
include measurements from the browser, and cover phone and desktop when changing
shared layouts or controls.

This applies to CSS, components, routes, chrome, on-screen copy, icons, empty and
error states, and focus indicators. Changes without a rendered surface use their
relevant gate output and regression evidence instead.

## Persistence contract

Read [docs/evidence/README.md](../../docs/evidence/README.md). That contract governs
all captures and recordings, including those produced by other skills or agent
hooks.

- Persist approved current-state evidence only under
  `docs/evidence/<feature>/<project>/<platform>/`. Use stable lowercase kebab-case
  names, for example `docs/evidence/unlock/pages/web/`. Feature names describe the
  implemented behavior; project and platform name the surface that implements it.
- Keep before/after comparisons, raw recordings, intermediate screenshots, failed
  runs, unapproved captures and review drafts in ignored `work/evidence/` or the
  system temp directory. Composed comparison sheets are review artifacts too;
  they do not belong in the current branch's persisted evidence.
- Replace the impacted feature/project/platform slot's approved artifacts and
  remove superseded files, including filenames the new capture no longer emits.
  Do not touch unrelated slots. Never append dates, branch names, versions or
  task identifiers to preserve an evidence history chain.
- Record source revision, capture method, checks and approval provenance beside
  the approved artifacts. Do not claim approval from a successful capture,
  migration, file timestamp, or the fact an old asset was committed. If approval
  or current-state verification is missing, keep the asset temporary and report
  the gap.
- Git history preserves previous evidence. Use commit-SHA links to view it;
  never restore historical recordings or screenshots into the current tree to
  perform a comparison. The default branch carries the latest approved state.

## Capture for review

`apps/pages/scripts/capture-evidence.mjs` captures two real builds and composes
review sheets. Keep its journey and output in an ignored scratch slot. Build the
base in a separate worktree; never swap source files or the index in a checkout
someone is using. Reuse the shared dependency and browser caches from AGENTS.md.

```bash
J=work/evidence/unlock/pages/web/journey.json

# Build the base revision in its own worktree first, then capture that build.
EVIDENCE_DIST=/absolute/path/to/base-worktree/apps/pages/dist \
  PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture before "$J"

# Capture the actual branch build with the same journey.
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs capture after "$J"

# Review sheets stay in the ignored journey directory.
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  node apps/pages/scripts/capture-evidence.mjs compose "$J"
```

Raw captures land in the system temp directory. Include measurements such as
`statusline 99px, wrapped → 49px, one row`, taken from the browser rather than
inferred from CSS. Capture the app as it runs: no hand-placed elements, devtools
overlays, or crops that hide the changed behavior.

### Journey example

```json
{
  "out": ".",
  "screens": [
    {
      "width": 390,
      "height": 844,
      "steps": [
        { "guest": null },
        { "tab": "Settings" },
        { "shot": "390-settings" }
      ]
    }
  ],
  "sheets": [
    {
      "shot": "390-settings",
      "width": 390,
      "title": "Settings controls — 390 × 844",
      "caption": "Touch targets measured from the two builds.",
      "before": "36px keys, 24px switches",
      "after": "44px throughout"
    }
  ]
}
```

A screen uses a phone context unless it sets `"desktop": true`. Steps include
`guest`, `tab`, `press`, `open`, `visit` (an in-app route), `arrive` (a cold load),
`pickFileOptional`, `escape` and `shot`. The script's `STEPS` and
`apps/pages/scripts/lib/capture-*-steps.mjs` define the supported steps.
`EVIDENCE_ORIGIN` captures a dedicated deployment;
`EVIDENCE_DIST` selects another built distribution. Name new steps after what a
person does.

## Review and promotion

Provide comparison measurements and links to review artifacts on the PR under
`## Visual evidence`. Use the available PR artifact or attachment mechanism;
never work around an unavailable upload by committing comparison media. State
any evidence delivery limitation plainly. Existing approved evidence on the
base can be linked at its original commit SHA without copying it forward.

After approval, promote only the approved current-state files into the stable
feature/project/platform slot using the canonical persistence contract. Remove
superseded assets in that slot. Its `README.md` describes what the current
artifacts show, the measurements and limits, capture method, source revision,
checks and approval provenance. Use relative image paths inside that gallery.
Keep the approved set small and relevant to the implemented feature.

To capture current-state screenshots into the scratch `current/` directory, run
`node apps/pages/scripts/capture-evidence.mjs capture current "$J"`. Review those
files, add a README with the actual checks and limitations, and obtain approval.

Prepare an approved-only candidate directory and replace its stable slot:

```bash
node scripts/dev/promote-evidence.mjs unlock/pages/web work/evidence/unlock/pages/web/current \
  --source <implementation-commit-sha> \
  --approved-by <reviewer-github-login> --approval-ref <review-url>
node scripts/quality/evidence-gate.mjs
node scripts/quality/docs-index.mjs
```

The promotion command writes the approval manifest and file hashes. Supply the
actual reviewed source commit and approval; do not invent either. `--approved-by`
is the reviewer's GitHub login, never a placeholder such as "pending review",
"tbd" or "unknown". `--approval-ref` is the
`https://github.com/OpenSesame-Labs/OpenSesame/...` address of the pull request,
review or comment that approved the captures. The promoter and the evidence gate
both refuse anything else (`scripts/lib/evidence-approval.mjs`).

Link the current-state gallery from the PR by commit SHA:

```markdown
## Visual evidence

Same journey on the base and branch builds. Review artifacts: <artifact link>.
Settings touch targets: 36px keys / 24px switches → 44px throughout.

[Approved current state](https://github.com/<owner>/<repo>/blob/<sha>/docs/evidence/<feature>/<project>/<platform>/README.md)
```

Read the posted PR back and verify that its links and markup survived. Some
GitHub tooling strips image embeds; a successful tool call alone does not show
what a reviewer can open.

If a visible change cannot be captured because a surface has no harness or the
flow requires an unavailable backend, name the missing evidence and what you
verified instead. Keep that gap visible and do not approve or persist a capture
you could not verify.
