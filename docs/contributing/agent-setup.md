# Agent setup (user scope)

Tracked harness files in this repo are product adapters only: product
hooks/enforcement and project-scoped MCP definitions. Everything personal
— model/subscription routing, permission auto-allows, plugin enablement,
API keys, dotfiles — is user scope. This page is how to set that up.
Canonical product/agent rules remain `AGENTS.md`.

## What stays tracked (project scope)

| File | Contents |
| --- | --- |
| `.claude/settings.json` | Product hooks only (`session-start.sh`, `design-lint.sh`) |
| `.codex/config.toml`, `.mcp.json`, `.cursor/mcp.json`, `opencode.json` | Project MCP trio: Storybook (`localhost:6006/mcp`), Stitch, shadcn `4.21.4` (pinned). Keys are env-var references, never values |
| `.codex/hooks.json` | Product impeccable UI hooks |
| `.cursor/rules/*.mdc` | Product rules. `grok-build-first`/`kimi-first` are thin adapters pointing here |
| `.github/copilot-instructions.md` | Bridge to `AGENTS.md` |
| `skills/` + 8 `.agents/skills/` aliases | First-party skill source and its discovery links. Third-party skills under `.agents/skills/` and the `.claude/skills`/`.grok/skills` mirrors are gitignored install output (see below) |

In `opencode.json`, Storybook and Stitch default to `enabled: false`
(they error without a running Storybook / a personal key). Enable them in
your user config when you use them; shadcn (local, pinned) stays enabled.

## Personal setup (user scope)

### Dotfiles with chezmoi

Keep personal harness config in your own dotfiles repo, applied with
[chezmoi](https://www.chezmoi.io/) — never in this repo, and never mounted
into a devcontainer by repo lifecycle commands.

```bash
chezmoi init --apply <your-dotfiles-repo>
chezmoi update        # pull + apply
chezmoi diff          # preview before applying
```

Devcontainers/Codespaces: use the editor's native dotfiles settings
(`dotfiles.repository`, `dotfiles.installCommand`, `dotfiles.targetPath`)
in your **user** settings. Git identity/signing comes from the editor's
native `.gitconfig` copy and SSH/GPG agent forwarding — never bind-mount
`~/.ssh`, `~/.gnupg`, or `~/.gitconfig` from repo config.

### Skills into `~/.agents/skills`

Install personal/third-party skills once at user scope:

```bash
mkdir -p ~/.agents/skills
# install or clone each skill as ~/.agents/skills/<name>/SKILL.md
```

For Claude, use a link adapter instead of copying (copies drift):

```bash
mkdir -p ~/.claude/skills
ln -s ~/.agents/skills/<name> ~/.claude/skills/<name>   # per skill
```

Project skills work differently in-repo: first-party source is `skills/`
(tracked, aliased from `.agents/skills/`); third-party skills install into
`.agents/skills/` with `.claude/skills/` and `.grok/skills/` mirrors, all
gitignored and restored from a pinned, previously tracked repository snapshot at container start by
`scripts/dev/install-agent-skills.sh`. The four previously tracked Impeccable Claude agent definitions remain tracked
so its independent-review workflow can run. The installer leaves existing
skills, mirrors and personal hooks untouched;
it creates a mirror only if the path is absent. Newly installed Scandinavian
verifiers use `PLAYWRIGHT_CHROMIUM` when set. Otherwise they use
`/opt/pw-browsers/chromium` if it exists, or Playwright's Chrome channel. This adjustment happens after the pinned source bytes are verified. A stopped installer can leave
`.agents/.skills-install.lockdir`; after confirming no install is running,
recover with `rmdir .agents/.skills-install.lockdir` and retry the install.

### Claude permissions (auto-allow)

Permission auto-allows are per-user trust decisions. Put them in the
gitignored `.claude/settings.local.json`, not tracked settings. The
product gate commands most contributors allow:

```json
{
  "permissions": {
    "allow": [
      "Bash(pnpm typecheck)",
      "Bash(pnpm lint)",
      "Bash(pnpm lint:all)",
      "Bash(pnpm test)",
      "Bash(pnpm test:all)",
      "Bash(pnpm test:integration)",
      "Bash(npx tsc --noEmit)"
    ]
  }
}
```

### Stitch plugins and `STITCH_API_KEY`

Stitch needs your own key: `export STITCH_API_KEY=...` in your shell/dotfiles
(secret store preferred). The tracked MCP stubs only name the env var.

The `google-labs-code/stitch-skills` marketplace plugins
(`stitch-design`, `stitch-build`, `stitch-utilities`) are **not**
auto-enabled by tracked settings — the same skills restore from a pinned,
previously tracked repository snapshot into `.agents/skills/stitch-*` at container start. To use the
marketplace copies instead, enable them in your user Claude settings
(`extraKnownMarketplaces` + `enabledPlugins` for
`google-labs-code/stitch-skills`).

### Model routing (operator profiles)

Tier routing, subscription auth, and quota fallbacks are operator setup.
This section is the chain's home; the `.cursor/rules/` adapters point here.

1. **Tier 1 — Grok Build CLI.** Delegate coding through
   `scripts/dev/grok-headless.sh` (subscription auth from
   `~/.grok/auth.json`, installed by
   `scripts/dev/grok-install-subscription-auth.sh`; never `XAI_API_KEY` —
   an API-key 403 is misconfiguration, not tier exhaustion). Resolve the
   model with `scripts/dev/grok-resolve-model.sh` and run
   `scripts/dev/agent-coding-preflight.sh` before batch work.
2. **Tier 2 — Kimi Code CLI.** Only when Grok itself reports a weekly
   limit/quota. Auth via `kimi login` (or `KIMI_MODEL_API_KEY`); runbook
   `.cursor/kimi-code.md`.
3. **Tier 3 — Cursor.** When Kimi is also exhausted: Grok model for
   security/red-team work, Composer/auto otherwise.

Record the tier used and why in the PR Provenance section. Details:
`.cursor/kimi-code.md` and `docs/operators/kimi-code-cloud.md` for runbooks,
and `scripts/dev/{grok,kimi,agent-coding}-preflight.sh` before batch work.
Never commit auth files, API keys, or `auth.preferred_method = "api_key"`
for device-login setups (see `.grok/config.toml`).

## Profiles

- **Default (tracked):** clone and open in any harness. Product hooks and
  MCP definitions work; nothing personal is assumed.
- **Personal (user):** chezmoi dotfiles + `~/.agents/skills` + Claude link
  adapter + `settings.local.json` + your `STITCH_API_KEY`.
- **Devcontainer:** `.devcontainer/devcontainer.json` — pinned Rust image,
  Node 22 feature at build time, user-writable corepack
  (`--install-directory "$HOME/.local/bin"`, `COREPACK_HOME` under
  `/home/vscode`), frozen-lockfile install in `updateContentCommand`,
  hooks in `postCreateCommand`, named volumes for cargo/pnpm/corepack.
  `postStartCommand` runs `scripts/dev/install-agent-skills.sh` only
  (missing optional skills from the pinned snapshot into gitignored roots;
  warns and continues offline when the snapshot is unavailable). No other `postAttach` work, no host paths, no dotfiles.
  In-container planes use `127.0.0.1` defaults (`scripts/dev/local-env.sh`).
- **Host-agent (opt-in, not tracked):** if you run host planes, add your
  own devcontainer override with
  `runArgs: ["--add-host=host.docker.internal:host-gateway"]` and
  `OPENSESAME_HOST_API`/`OPENSESAME_ISSUER`/`OPENSESAME_AGENT_URL`
  pointing at `host.docker.internal:8787/8788/18790`. Do not commit it:
  the host-agent socket contract is not wired in-repo.

## Update / rollback

- Dotfiles: `chezmoi update`; rollback with `chezmoi apply` at an older
  dotfiles revision (`git -C "$(chezmoi source-path)" checkout <rev>`).
- Personal skills: update in `~/.agents/skills` only; links follow.
  Rollback = restore that directory; no repo change needed.
- Project skills: change the pinned source commit and tree only in a reviewed
  commit after reviewing all included skill contents. Existing installed
  skills remain untouched; remove or back up a local copy before reinstalling.
- Harness config changes in-repo: keep them adapter-sized. Rollback is a
  plain `git revert` of the config commit — personal state above is
  unaffected because none of it is tracked.
- Devcontainer: rebuild (`Dev Containers: Rebuild Container`) after image
  or feature changes; named volumes survive rebuilds. Delete the
  `opensesame-*` volumes to fully reset caches.

## Acceptance checklist

- [ ] Tracked settings contain no model/provider routing, permission
      allows, plugin enablement, API keys, or absolute home paths
      (`git grep -nE 'api_key|STITCH_API_KEY=|/Users/|/home/[a-z]' -- .claude .codex .cursor .grok .devcontainer opencode.json .mcp.json` is clean apart from env-var names)
- [ ] `python3 -m json.tool` parses every tracked `*.json` harness file;
      `python3 -c "import tomllib,sys; [tomllib.load(open(f,'rb')) for f in sys.argv[1:]]"` parses `.codex/config.toml` and `.grok/config.toml`
- [ ] `node scripts/dev/sync-agent-skills.mjs --check` exits 0; no broken
      symlinks under `.claude/skills`, `.grok/skills`, `.agents/skills`
- [ ] Product hooks still fire: edit a `.tsx` file → design-lint /
      impeccable hook runs; session start stays inert without
      `OPENSESAME_AGENT_BOOTSTRAP=1`
- [ ] MCP trio definitions identical across `.codex/config.toml`,
      `.mcp.json`, `.cursor/mcp.json`, `opencode.json` (URLs + `shadcn@4.21.4`)
- [ ] Devcontainer: `postStart` runs only the skills install, no `postAttach`,
      no `host.docker.internal`,
      no `${localEnv:HOME}` mount; `id` in lifecycle is `vscode`;
      `node -v`, `pnpm -v`, `cargo -V` succeed after create
- [ ] Personal layer works from a clean clone: chezmoi apply →
      `~/.agents/skills` → Claude links → `settings.local.json` →
      optional Stitch key/plugins and tier routing
