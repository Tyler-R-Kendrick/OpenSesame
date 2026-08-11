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
One store, four readings of it:

- **Humans** keep passwords, passkeys, cards, and notes here. This is the
  Bitwarden/1Password job, and it sets the craft bar.
- **Agents** are handed scoped grants against secrets they can never read. The
  Agents section shows the ceilings and what a running task narrowed to.
- **Websites** use OpenSesame as their auth broker. The Sites section registers
  the origin-pinned public clients and shows the sign-in events they produced.
- **Developers** treat it as the authority: prove identity, authorize devices,
  claim what those devices created, read what the protocol guarantees.

## Task
Create or unlock the vault with a master password → work in one of the four
sections → lock, which discards the key.

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
