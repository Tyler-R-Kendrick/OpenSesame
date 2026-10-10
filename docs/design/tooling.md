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

- **It is the app, not a copy of it.** `.storybook/preview.tsx` loads the
  stylesheets `src/main.tsx` loads, in the same order, and `.storybook/host.ts`
  installs the browser host the app installs (ADR 0133), with an empty
  capability table. `.storybook/vite.config.ts` carries the app's aliases and
  defines and none of its build plugins. Never restyle a component for the
  catalog; if a story looks wrong, the component is wrong.
- **Stories live in `apps/pages/stories/`**, outside `src/`: the capability
  classification gate walks every file under `src` and the shipped bundle must
  never reach a story. One file per component, grouped `Brand`, `Controls`,
  `Status`, `Shell`.
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
- **Skills that do not apply here.** The repo ships the whole `stitch-skills`
  catalogue so the plugins match upstream, but `shadcn-ui`, `remotion`,
  `react-vite-dashboard` and `stitch::react-native` describe stacks this app
  does not use. An agent reaching for them in `apps/pages` is off the contract.

## Per-agent configuration

Skills are installed by the skills CLI (`npx skills add
google-labs-code/stitch-skills -y --copy -a <agent>`), pinned in
`skills-lock.json`; `npx skills update` refreshes them. The MCP files name the
same two servers everywhere.

| Agent | Skills | MCP servers (Storybook + Stitch) |
|-------|--------|----------------------------------|
| Claude Code | `.claude/skills/` (copies), and the `stitch-design`, `stitch-build`, `stitch-utilities` plugins enabled in `.claude/settings.json` from the `google-labs-code/stitch-skills` marketplace | `.mcp.json` (`${STITCH_API_KEY}`) |
| Cursor | `.agents/skills/` | `.cursor/mcp.json` (`${env:STITCH_API_KEY}`) |
| Codex | `.agents/skills/` | `.codex/config.toml` (`env_http_headers`) |
| Grok Build | `.grok/skills/` | add the two URLs with `grok mcp add`; the key as the `X-Goog-Api-Key` header |
| Cline | `.agents/skills/` | Cline's MCP settings are user-level: add the two URLs under *MCP Servers › Remote*, the key as a header |
| Kimi Code CLI | `.agents/skills/` | `kimi mcp add --transport http stitch https://stitch.googleapis.com/mcp --header "X-Goog-Api-Key: $STITCH_API_KEY"` and the same for Storybook |
| OpenCode | `.agents/skills/` (and `.claude/skills/`) | `opencode.json` (`{env:STITCH_API_KEY}`) |
| Muse | not a target of the skills CLI or `npx plugins`; point it at `.agents/skills/` | the same two URLs, the key as a header |

Claude Code's plugin form (`npx plugins add google-labs-code/stitch-skills
--scope project --target claude-code`) records the install in the user's own
`~/.claude/plugins/`; the project settings turn the plugins on for every
collaborator, and the copied skills under `.claude/skills/` work in a cloud
session, where a project's marketplaces do not load.
