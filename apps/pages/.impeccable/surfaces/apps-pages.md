---
version: 1
slug: "apps-pages"
primary_target: "apps/pages"
related_targets:
  - "apps/pages/index.html"
  - "apps/pages/src/screens/UnlockScreen.tsx"
  - "apps/pages/src/components/AppShell.tsx"
  - "apps/pages/src/sections/VaultSection.tsx"
  - "apps/pages/src/lib/vault/crypto.ts"
---

# Surface brief: apps/pages

## Scope & mode
Operate — an end-to-end encrypted vault client, installable as a PWA, served
as a static site.

## Audience / job
One store, five readings of it:

- **Humans** keep passwords, passkeys, cards, and notes here. This is the
  Bitwarden/1Password job, and it sets the craft bar.
- **Agents** are handed scoped grants against secrets they can never read. The
  Agents section shows the ceilings and what a running task narrowed to.
- **Services** are authorized once and then brokered. The Connections section
  runs the consent round trip, then binds one authorization to the projects and
  agents allowed to act through it.
- **Websites** use OpenSesame as their auth broker for static hosts (Shoo-style
  origin profile via `/broker/authorize` + `auth.js`). The Sites section
  issues the drop-in snippet and remembers approved RP origins; Identity-plane
  client registration remains optional when a live issuer is available.
- **Developers** treat it as the authority: prove identity, authorize devices,
  claim what those devices created, read what the protocol guarantees.

## Task
Create or unlock the vault with a master password → work in one of the four
sections → lock, which discards the key.

Arriving from another manager is its own first-run task: pick an export from
Bitwarden, 1Password, a browser, LastPass, KeePass, Dashlane, NordPass, or
Proton Pass → read what was found and what the format could not carry → choose
where it lands → import.

## Constraints
- The master password derives the vault key with 600,000 PBKDF2-SHA256
  iterations; contents are sealed with AES-256-GCM. The key exists in memory
  only while unlocked, and there is no recovery path.
- Ciphertext lives in OPFS. No `localStorage` for anything sealed. A reload
  re-locks, and that is correct behavior, not a bug.
- Static hosting. Identity and Host planes are remote and configurable, and
  every network-backed surface has to state what it cannot show while offline
  or unauthenticated rather than rendering an empty frame.
- Sample data is opt-in from Settings, badged on every item, and removable in
  one action.
- TOTP codes, password generation, strength, and the health report are computed
  in the page. Nothing about a password, including a hash of one, leaves the
  device.
- Imports are parsed in the tab, including unzipping a 1Password `.1pux` with
  `DecompressionStream`. An import must preview before it writes, must say what
  a given format cannot carry, and must name the plaintext export still sitting
  in the user's downloads.
- Connections are the one asset the device does not hold: the authority plane
  keeps provider tokens because it has to renew them while nobody is watching.
  That inversion has to be stated on the surface, not buried — and no view,
  ever, renders a token, a refresh token, or a client secret.
- A provider with no OAuth client registered on the deployment is listed with
  the exact environment variables it is missing. A connect button that cannot
  work is worse than an honest absence.

## Direction
Bitwarden and 1Password set the bar. Light canvas, navy rail, teal accent, a
list-and-detail spine for the vault, and full-width panels for the three
plane-backed sections.

## Memorable moment
The empty detail pane is not a shrug. It answers what is in the vault, what
changed recently, and what needs attention — so an unlocked vault is already
telling you something before you click anything.

## Unresolved
None outstanding.
