# Settings › Capabilities — features, always-on, Allow guests

Before/after from two real builds — the base (`a5b0925`) and this branch — same
journey (`journey.json`): continue as guest on an empty device, open Settings ›
Capabilities, switch Backups on, apply. Counts were read from the browser by
the journey's `count` steps.

## Capabilities at phone width

`31 catalog rows (7 core "always on", 24 optional), 0 switches` →
`Guests + 8 feature rows, one switch each; 15 optional rows under Advanced`

![Capabilities, 390](390-capabilities.png)

## Capabilities and the rail at desktop width

Rail `vault, settings` → `vault, connections, access, activity, settings`:
the always-on functions are back for a fresh guest, and none is a switch.

![Capabilities, 1280](1280-capabilities.png)

## Backups switched on — phone

`no Backups switch, 0 git provider tiles on this page` →
`Backups on → 6 git providers under it (Git, GitHub, GitLab, Bitbucket, Codeberg, Cursor Origin)`

![Backups on, 390](390-backups-on.png)

## Backups switched on — desktop

![Backups on, 1280](1280-backups-on.png)

## Providers of always-on functions

`0 provider groups on Capabilities` → `5 groups (identity providers,
encryption, password managers, cloud secret storage, local storage), no group
switch`

![Providers, 1280](1280-providers.png)
