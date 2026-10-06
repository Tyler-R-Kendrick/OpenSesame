# Encrypted search: Settings › Capabilities

[ADR 0175](../../adr/0175-searchable-encryption-over-indexeddb.md). The one
visible change is a new section on Settings › Capabilities, with the switch of
the `storage.encrypted-search` capability. Two real builds (the base commit
`e53d2a2c` and this branch), walked the same way by `journey.json`, at desktop
and phone width. The "after" panes are scrolled to the section; the "before"
panes show the top of the page, because the section does not exist there.

| Sheet | What it shows |
|-------|---------------|
| [`1280-section-off.png`](1280-section-off.png) | Desktop: the section, switch off |
| [`1280-section-on.png`](1280-section-on.png) | Desktop: the switch pressed, committed in place with no review |
| [`390-section-off.png`](390-section-off.png) | Phone: the section, switch off |
| [`390-section-on.png`](390-section-on.png) | Phone: the switch pressed |

Measured in the browser (`count` and `report` steps of the journey):

| | Before | After |
|---|---|---|
| Sections on the page (`.capsection`) | 15 | 16 |
| Switches (`[role=switch]`) | 35 | 36 |
| Switches on, after pressing Encrypted search | 1 | 2 |
| Encrypted search in the section list | absent | after Backups |

The section carries one switch and no other control: a Settings row acts or is
not drawn (ADR 0158). Nothing else on the page moved; the phone layout reuses
the existing section row.

What the switch does to the browser's storage is not visible here and is
proved by `pnpm --filter @opensesame/pages verify:encrypted-search`, which reads
every IndexedDB record of the built app before and after.
