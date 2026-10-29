# Design tooling: Storybook, Figma, Stitch

Three tools, three roles, one contract ([`DESIGN.md`](../../DESIGN.md),
[`controls.md`](controls.md)). None of them replaces the gates in
[AGENTS.md §5](../../AGENTS.md); they are how a visual change is proposed,
agreed and catalogued before it is measured.

| Tool | Role | Lives in |
|------|------|----------|
| **Storybook** | *Defines* the system. Every delivered component, in every state, on the app's own stylesheet and host. The catalog an agent reads before building, and the place a component's contract is measured. | `apps/pages/.storybook/`, `apps/pages/stories/` |
| **Figma** | *Sets the look* a component must meet. A frame per page and per component; the story's Design tab links the frame it answers to, so visual parity is a side-by-side, not a memory. | The OpenSesame Figma file; its key in `apps/pages/stories/figma.ts` |
| **Stitch** | *Experiments.* Rapid prototypes of alternatives from `.stitch/DESIGN.md`, generated and varied by prompt, thrown away freely. A prototype that wins becomes a Figma frame, then a component, then a story. | `.stitch/`, the `stitch-*` skills, the Stitch MCP server |

The loop: prototype in Stitch → choose → draw the frame in Figma → build the
component on the app's CSS → story it with the Design link → run the gates and
capture the evidence (`skills/visual-evidence/SKILL.md`).

## Storybook

```bash
pnpm --filter @opensesame/pages storybook            # :6006, MCP at /mcp
pnpm --filter @opensesame/pages build-storybook      # apps/pages/storybook-static
pnpm --filter @opensesame/pages typecheck:storybook  # the config and every story
```

- **Browse it without a checkout.** A static build is published as a Claude
  artifact, *OpenSesame Storybook*, with shortcuts to the front door, the unlock
  stage, the wordmark, the mark, the controls and the status marks. Rebuild it
  with `build-storybook` and republish the folder after a change to a
  component or a story.
- **It is the app, not a copy of it.** `.storybook/preview.tsx` loads the
  stylesheets `src/main.tsx` loads, in the same order, and `.storybook/host.ts`
  installs the browser host the app installs (ADR 0133), with an empty
  capability table. `.storybook/vite.config.ts` carries the app's aliases and
  defines and none of its build plugins. Never restyle a component for the
  catalog; if a story looks wrong, the component is wrong.
- **Stories live in `apps/pages/stories/`**, outside `src/`: the capability
  classification gate walks every file under `src` and the shipped bundle must
  never reach a story. One file per component, grouped `Gates`, `Brand`,
  `Controls`, `Status`, `Shell`. The gates (`Gates/Front door`,
  `Gates/Unlock stage`) are whole screens with their real motion: the
  decode, the shimmer, the idle dial, and the ceremony from the unlock
  story's go key.
- **Every delivered component gets a story** with its real states (armed,
  busy, disabled with its reason, each status tone) and the sentence the
  component carries as its accessible name. Tag it `ai-generated` when an agent
  wrote it, and drop the tag once a person has reviewed it. Keep `play` for a
  measurement only: `Status/StatusMark › CssCheck` reads `getComputedStyle` to
  prove the err tone is a grey and the mark has square corners, and it is the
  one CSS check.
- **Both themes.** The toolbar's Theme switch sets `data-theme` on the root the
  way Settings › General › Appearance does. Verify a new story at Day and Night
  before it ships.
- **MCP.** `@storybook/addon-mcp` serves `http://localhost:6006/mcp` while the
  dev server runs; the agent configurations below register it. Ask it for the
  UI-building instructions and the components manifest before writing a
  component.
- **A11y** runs through `@storybook/addon-a11y` in the catalog's panel; the
  product's own keyboard, touch and visual gates stay the merge gates.

## Figma

Figma holds the look a component must meet: one frame per gate (front door,
unlock, setup), per shell screen (vault listing and record, editor,
connections, access, identity, settings, keymap sheet, notifications) and per
component in the catalog, at 390 and 1280, Day and Night, drawn in the DESIGN.md
tokens (greyscale, square corners, 44px keys).

- Put the file's key in `apps/pages/stories/figma.ts` (`FIGMA_FILE`); each
  story's `figma("<node-id>")` then resolves and `@storybook/addon-designs`
  draws the frame in the story's Design tab.
- Parity is checked side by side: the frame in the Design tab, the component
  in the canvas, at the same width and theme. A difference is either a bug in
  the component or a change to make in the frame; it is never left to drift.
- The Figma connector in Claude is what draws and reads the frames from a
  session; it has to be enabled in the chat's connector settings before an
  agent can design there.

## Stitch

Google Stitch prototypes from a `DESIGN.md`: `.stitch/DESIGN.md` is written in
Stitch's semantic format from the app's live tokens, and the `stitch-*` skills
know how to generate screens, vary them, manage the design system and pull a
prototype back as static HTML.

- **Set-up.** Create a Stitch project for OpenSesame, paste its `projects/<id>`
  into `.stitch/DESIGN.md`'s Project ID line, then upload the design system
  (`stitch::manage-design-system`: "Upload our design system from
  `.stitch/DESIGN.md`"). Generated screens and extracted HTML land under
  `.stitch/designs/` and stay out of git.
- **Credentials.** `STITCH_API_KEY` (Stitch › Settings › API keys) is declared
  `@sensitive` in `.env.schema` and read from the environment by every agent
  configuration below; it is never written into a config file.
- **What it is for.** Alternatives: a second arrangement of the record screen, a
  different door, a denser list. A Stitch screen is a sketch. Nothing moves
  from Stitch into `apps/pages` directly; it goes through Figma and then a
  component on the app's own CSS.
- **Skills that do not apply here.** The install catalogue carries the whole
  `stitch-skills` set so plugin installs match upstream, but `shadcn-ui`, `remotion`,
  `react-vite-dashboard` and `stitch::react-native` describe stacks this app
  does not use. An agent reaching for them in `apps/pages` is off the contract.
  They are catalogued as `unusedStack` under the `design-experiment-optional`
  profile in `skills/profiles.json`; installed on disk they match upstream
  (gitignored, refreshed at container start), but they are not defaults.

## shadcn/ui: DESIGN.md as a design-system page

The `shadcn` skill (shadcn-ui/ui `skills/shadcn`) reads a `DESIGN.md` and
restyles shadcn/ui from it: it scaffolds a scratch Vite app from a style,
installs every component, maps the frontmatter tokens and the prose rules onto
the theme and the component recipes, and builds a design-system page with
contrast-checked colour pairs, pinned state matrices and do/don't pairs
(`.claude/skills/shadcn/design-system.md`). It is how an agent checks that this
repository's `DESIGN.md` is complete enough to theme a different component
library: a rule that cannot be expressed in tokens shows up as a gap.

- **Where it runs.** In a scratch directory outside the repository, never in
  `apps/pages`: the app has no `components.json`, no Tailwind, and its controls
  are its own (`docs/design/controls.md`). Nothing moves from the shadcn page
  into `apps/pages`.
- **How to run it.** Ask for it by name: "build a shadcn design system from
  `DESIGN.md` with the lyra style". `lyra` (boxy, sharp, mono) is the style
  closest to this system's geometry; the theme maps the greyscale ladder, the
  app's own night palette, radius 0 on every step (and an unlayered rule for
  `rounded-full`), hairline elevation, the ink focus outline and the 44px
  coarse-pointer floor; `destructive` is ink, because a control is never red.
- **MCP.** `shadcn@4.21.4 mcp` (stdio, pinned) is registered next to Storybook
  and Stitch for Claude Code, Cursor, Codex and OpenCode. It searches and views
  registries; `get_project_registries` errors here by design, since the
  repository has no `components.json`.

## Per-agent configuration

Skills have one canonical installation under `.agents/skills/`. First-party
skills are canonical in `skills/`; third-party skills are optional profiles
catalogued in `skills/profiles.json` (see `skills/README.md`), not universal
defaults. Most are catalogued in `skills-lock.json` and installed at latest
(unpinned) by `scripts/dev/install-agent-skills.sh`; the exceptions are
`design-system` and `impeccable` (its own updater). Core validation passes
with the optional profiles uninstalled. Update that installation once, then run
`node scripts/dev/sync-agent-skills.mjs` and its `--check` mode. Other harnesses
share relative links; do not install copied trees for each agent. The MCP files name the
same two servers everywhere.

| Agent | Skills | MCP servers (Storybook + Stitch + shadcn) |
|-------|--------|----------------------------------|
| Claude Code | `.claude/skills/` (installed mirror links); Stitch marketplace plugins are user-scope opt-in (see `docs/contributing/agent-setup.md`), not enabled by tracked settings | `.mcp.json` (`${STITCH_API_KEY}`) |
| Cursor | `.agents/skills/` | `.cursor/mcp.json` (`${env:STITCH_API_KEY}`) |
| Codex | `.agents/skills/` | `.codex/config.toml` (`env_http_headers`) |
| Grok Build | `.grok/skills/` | add the two URLs with `grok mcp add`; the key as the `X-Goog-Api-Key` header |
| Cline | `.agents/skills/` | Cline's MCP settings are user-level: add the two URLs under *MCP Servers › Remote*, the key as a header |
| Kimi Code CLI | `.agents/skills/` | `kimi mcp add --transport http stitch https://stitch.googleapis.com/mcp --header "X-Goog-Api-Key: $STITCH_API_KEY"` and the same for Storybook |
| OpenCode | `.agents/skills/` (and `.claude/skills/`) | `opencode.json` (`{env:STITCH_API_KEY}`) |
| Muse | not a target of the skills CLI or `npx plugins`; point it at `.agents/skills/` | the same two URLs, the key as a header |

Claude Code's plugin form (`npx plugins add google-labs-code/stitch-skills
--scope project --target claude-code`) records the install in the user's own
`~/.claude/plugins/`; enabling it is a user-scope choice (tracked settings
no longer turn plugins on for collaborators). In cloud sessions, where a
project's marketplaces do not load, the installed `.claude/skills/` mirrors
from `scripts/dev/install-agent-skills.sh` provide the same skills.

## Keep design artifacts small

In `docs/design/canvases/*/` with a `build.mjs`, version only source fragments,
shared styles, generator and layout metadata. Run the generator on demand before
seeding; generated `.dc.html` artboards and seeded editor payloads stay ignored.
Editor extraction happens in temporary storage and accepted changes must be
reconciled into the generator inputs before rebuilding. Do not accumulate dated
exports or review rounds in the source tree.

The five `settings-connectivity/*.dc.html` files have no generator or source
fragments and remain source artboards; this exception does not permit checking
in generated pages from the other canvases. Review screenshots follow
`docs/evidence/README.md` and approved current-state persistence.
