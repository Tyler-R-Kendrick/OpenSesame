# skills/

Agent skills — self-contained instructions a coding agent loads for one kind
of task. Each directory holds a `SKILL.md` with a `description` the agent
matches against. [`.agents/skills/`](../.agents/skills) links to each of these
for tools that look there; third-party skills installed by their own updaters
live once in `.agents/skills/`. `.claude/skills/` and `.grok/skills/` link to
that canonical install. Agent-specific instruction variants remain separate;
identical files within those variants link to the canonical copy.

After a reviewed upstream update, run `node scripts/dev/sync-agent-skills.mjs`
then `node scripts/dev/sync-agent-skills.mjs --check`. Install or update the
canonical skill once; do not use multi-agent `--copy` installations. The sync
command compares bytes and executable modes before replacing a duplicate and
never discards differing instructions. If an installer materializes mirrors,
sync them again before staging.

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

A new skill gets a directory here, a symlink in `.agents/skills/`, and a row in
the skills table in [`AGENTS.md` §7](../AGENTS.md#7-skills).
