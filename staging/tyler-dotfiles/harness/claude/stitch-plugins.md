# Stitch plugins (personal, opt-in)

Exported from OpenSesame `docs/contributing/agent-setup.md`. install.sh does
not enable these. Tracked OpenSesame settings do not enable them either.

The `google-labs-code/stitch-skills` marketplace plugins `stitch-design`,
`stitch-build`, and `stitch-utilities` are a personal choice. The same skills
also install, unpinned, into the project's `.agents/skills/stitch-*` from
`skills-lock.json` at container start. To use the marketplace copies, enable
them in your user Claude settings with `extraKnownMarketplaces` and
`enabledPlugins` for `google-labs-code/stitch-skills`.

`STITCH_API_KEY` is not stored here. `harness/shell/stitch-env.sh` exports it
when `~/.config/tyler-dotfiles/stitch-api-key` exists (mode 600).
