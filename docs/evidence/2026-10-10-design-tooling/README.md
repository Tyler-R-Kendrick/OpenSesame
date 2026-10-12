# Design tooling: Storybook on the app's own CSS

Not a change to the shipped app — no screen of `apps/pages` draws differently —
so there is no before/after pair. The sheets show the Storybook catalog that
this change adds (`apps/pages/stories/`), built with `build-storybook` and
walked story by story in headless Chromium at 900×500 (`iframe.html?id=…`,
Day then Night), every story rendering with no page or console error.

| Sheet | What it shows |
|-------|---------------|
| `storybook-stories.png` | Twelve of the 35 stories, Day on the left and Night on the right: the wordmark's particle field (516×97) and solid tier (224×62), the armed delete key (76×76, inverted ink), the four status tones in a row (184×52), a field row with its reveal and copy keys (868×63), a form commit with a second key (170×76), the crumb trail (868×50) and every empty-state tip (868×191). |
| `storybook-icons.png` | The icon gallery: every glyph exported from `components/Icons*.tsx`, 20px, in `currentColor`. |

Measurements are the `#storybook-root` bounding boxes the walk printed; the
`Status/StatusMark › CssCheck` story asserts in the browser that the err tone's
computed colour is a grey (R = G = B) and its `border-radius` is `0px`.
