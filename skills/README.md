# skills/

Agent skills — self-contained instructions a coding agent loads for one kind
of task. Each directory holds a `SKILL.md` with a `description` the agent
matches against. [`.agents/skills/`](../.agents/skills) links to each of these
for tools that look there; those 8 aliases are the only `.agents/` entries in
source control. Third-party skills are **install output, not source**: they
are restored into `.agents/skills/` (plus harness mirrors) by
`scripts/dev/install-agent-skills.sh` — run at every devcontainer start, or
`pnpm skills:install` locally — from the catalogue in
[`skills-lock.json`](../skills-lock.json), and every harness root is
gitignored except the repo-built adapters whitelisted in `.gitignore`.

After a reviewed upstream update, run `node scripts/dev/sync-agent-skills.mjs`
then `node scripts/dev/sync-agent-skills.mjs --check`. Install or update the
canonical skill once; do not use multi-agent `--copy` installations. The sync
command compares bytes and executable modes before replacing a duplicate and
never discards differing instructions. Installed trees are never staged.

## Ownership tiers

The machine-readable catalogue is [`profiles.json`](profiles.json). Edit it
together with this file; `sync-agent-skills.mjs --check` fails on a `skills/`
or `.agents/skills/` entry that no profile lists, a core skill without its
`.agents/skills/` alias, or a skill listed in two profiles.

- **First-party default (`core`, required).** Authored here, canonical in
  `skills/`, aliased from `.agents/skills/`. Core validation requires every
  one of them.
- **Reusable optional (`reusable-optional`).** Third-party and generic, but
  part of a workflow this repo uses (the applicable Stitch toolchain,
  `impeccable`, `gdp-ts`). Canonical in `.agents/skills/`; a separate install
  may live in `.agents/skills-optional/` and the sync checker resolves either.
- **Design-experiment optional (`design-experiment-optional`).** Third-party
  aesthetics and stack catalogues kept for experiments. They are not defaults
  for work in `apps/pages`.

Optional skills may be absent: core `--check` passes with none of them
installed. A harness mirror (`.claude/skills/`, `.grok/skills/`) left behind
for an uninstalled optional skill is skipped by the checker; removing it is
the harness owner's job. An unlisted or core name without a canonical install
still fails.

Provenance: optional skills are restored from a pinned, previously tracked Git tree
by `scripts/dev/install-agent-skills.sh`. The installer checks every staged
file against that tree before making it discoverable. The three Scandinavian
verifiers then receive the repository Chromium-path adjustment on first install. Updating the snapshot
requires a reviewed commit and tree pin. Existing local skills and personal
hooks are left untouched. The tiers say what is a default; a fresh clone has
only the core profile until install runs. Anything a build or gate depends on
must be core.

## Using OpenSesame

| Skill | For |
|---|---|
| [`opensesame-apis`](opensesame-apis/SKILL.md) | Configuring and calling the Host and Identity APIs. |
| [`opensesame-clis`](opensesame-clis/SKILL.md) | The host CLI (`opensesame`) and client CLI (`opensesame-id`). |
| [`opensesame-mcps`](opensesame-mcps/SKILL.md) | Installing and using the MCP servers. |
| [`opensesame-chrome-extension`](opensesame-chrome-extension/SKILL.md) | Installing and using the browser extension. |

## Developing OpenSesame

| Skill | For |
|---|---|
| [`local-debug-session`](local-debug-session/SKILL.md) | "Run it locally": an attached Vite HMR session with the browser console watched, never a static preview. |
| [`visual-evidence`](visual-evidence/SKILL.md) | Before/after screenshots from two real builds for any user-visible change. |
| [`security-review`](security-review/SKILL.md) | The deterministic security gates and budgeted Codex Security scans. |
| [`install-anti-slop`](install-anti-slop/SKILL.md) | Installing the anti-slop Oxlint plugin into another repository; its `assets/` mirror [`tools/oxlint/anti-slop`](../tools/oxlint/anti-slop) (`pnpm test:anti-slop` checks they match), `install.mjs --no-tests` leaves the test suites out, and the asset's `MANIFEST.sha256` and `verify.mjs` let a consuming repository check its copy offline (`pnpm anti-slop:manifest` regenerates the manifest). |

## Reusable optional (third-party, in `.agents/skills/`)

| Skill | For |
|---|---|
| `design-md` | Generating a `DESIGN.md` from a Stitch project. |
| `enhance-prompt` | Polishing a prompt before sending it to Stitch. |
| `gdp-ts` | Compile-time authorization proofs in TypeScript (ADR 0178 workflow). |
| `impeccable` | Generic frontend design, critique, and audit. Also wired into the pre-commit hook and Codex hook; removing it needs those owners. |
| `site-md` | Maintaining the `.stitch/SITE.md` site constitution. |
| `stitch-code-to-design` | Sending existing code to Stitch as a design. |
| `stitch-extract-design-md` | Extracting a `DESIGN.md` from a Stitch screen. |
| `stitch-extract-static-html` | Extracting static HTML from a Stitch screen. |
| `stitch-generate-design` | Generating a Stitch design from a prompt. |
| `stitch-loop` | The autonomous Stitch build loop. |
| `stitch-manage-design-system` | Managing a Stitch design system. |
| `stitch-react-components` | Converting a Stitch screen to Vite/React components. Nothing moves from Stitch into `apps/pages` directly; see `docs/design/tooling.md`. |
| `stitch-upload-to-stitch` | Uploading an image or file to a Stitch project. |
| `taste-design` | Anti-generic guidance for Stitch `DESIGN.md` files. |

The `stitch-*` directories declare colon frontmatter names (`stitch::*`);
that is upstream's naming and is kept as-is.

## Design-experiment optional (third-party, in `.agents/skills/`)

Invoke these by name for an experiment; do not treat their tokens or stacks
as the contract for `apps/pages` (`DESIGN.md` wins on any conflict).

| Skill | Note |
|---|---|
| `design-system` | Generic TypeUI design-system tokens. Declares frontmatter `name: minimal`. Not in `skills-lock.json`. |
| `design-taste-frontend` | Landing pages, portfolios, and redesigns. Its own body excludes dashboards and multi-step product UI. |
| `react-vite-dashboard` | Unused stack: TanStack Query + Web3 dashboards. Not used by this app. |
| `remotion` | Unused stack: Remotion walkthrough videos. Not used by this app. |
| `scandinavian-design` | Black-and-white restraint, invoke-only (`disable-model-invocation`). |
| `shadcn` | Scratch-only: restyles shadcn/ui from `DESIGN.md` outside the repo to test its completeness, never in `apps/pages`. |
| `shadcn-ui` | Unused stack: the Stitch-build shadcn variant (Radix/Tailwind). Not used by this app. Distinct from `shadcn`. |
| `stitch-react-native` | Unused stack: React Native conversion. Not used by this app. |

A new first-party skill gets a directory here, a symlink in `.agents/skills/`,
a row in the [skills index](../docs/contributing/skills.md), an entry under
`core` in `profiles.json`, and whitelist lines in `.gitignore` (both the
`skills/` and `.agents/skills/` sections — harness roots ignore by default). A new third-party skill gets an entry
in one optional profile in `profiles.json` (and a `skills-lock.json` entry when
its updater provides one).
