# ADR 0089 — Several vaults on one device, and a front door to choose between them

- Status: Accepted
- Date: 2026-09-01
- Supplements: [ADR 0033](0033-federated-identity-admission.md) (guest principal,
  identity before sealing), [ADR 0038](0038-multi-tomb-sealed-store.md) and
  [ADR 0063](0063-encrypted-vfs-tombs.md) (every project vault is a tomb; names are
  sealed, tomb ids are not), [ADR 0065](0065-agent-surface-parity.md)
  (capability registry; ceremonies stay human)

## Context

A device holds more than one vault at once. Every project is its own tomb, the
personal vault is the `personal` tomb, and since the guest flow was restored
beside a sealed vault a guest session runs in its own `guest` tomb rather than
touching whichever vault the boot pointer named. What the app offered to move
between them was a 14rem dropdown behind the `@tomb` prompt — reachable only
after one vault was already open, silent about the fact that every swap locks
you out, and absent from the one place the choice actually has to be made: the
locked screen a device opens on.

Two facts constrain any design:

1. **A vault's display name is a secret.** It lives in `config/projects`
   inside the sealed tomb. Before unlock the plaintext facts about a project
   tomb are its id and its header's `createdAt`, and nothing else.
2. **The store holds one key.** A swap to a tomb sealed with a different key
   cannot carry the session across; the only tomb that can open without a
   prompt is one whose header carries the same wrap material — exactly what
   `forkUnlockedIntoActiveScope` writes when a project is sealed "with this
   vault's key".

## Decision

**One list, rendered in three places by one component.** `lib/vaults.ts` is
the single view of the vaults on a device — `listDeviceVaults()` — and
`components/VaultList.tsx` is the single row: a mark for the kind, the label,
one line of truth (when it was sealed, how it opens), and a state chip. It is
rendered by:

- the **front door** (`screens/VaultsScreen.tsx`): a device holding more than
  one vault opens on the choice, not on the boot pointer's tomb. Picking a
  vault lands on *its* Unlock form, which carries a `‹ Vaults / <tomb> :/`
  crumb back.
- the **`@tomb` prompt** inside a vault (`components/ProjectSwitcher.tsx`),
  whose header says what a switch costs — *switching locks this one* — where
  the cost is paid.
- **Settings → Vaults** (`sections/settings/VaultsPanel.tsx`): the one place a
  vault is sealed with a choice (share this vault's key, or seal it with its
  own) and the only place one is deleted — never the personal vault, never the
  open one, and armed in place before it does anything.

**Names stay honest.** `vaultLabel` renders `project · 4f2a` and "name is
inside the vault" for a sealed project before unlock. No plaintext nickname is
introduced; the friendlier front door is not worth one leaked word.

**Shared-key vaults open without a prompt.** `VaultStore.sharesKeyWith` proves
it by comparing wrap material, and `openActiveScopeWithCurrentKey` moves the
scope and reopens with the key already in hand. Anything else locks and
lands on the unlock screen, and the row said so first.

**Guest is a peer, not a sign-in road.** It sits in the same list, in every
placement, and is never withheld (AGENTS.md §5). "Use without an account" is
deliberately absent from the switcher: it would seal a second vault in place.

## Consequences

- The capability `vaults.switch` is registered on the PWA and excluded from
  every agent surface: choosing which tomb is open is a human ceremony at the
  unlock boundary; an agent holds a ConnectionRef into one open vault.
- A project's name typed before its tomb has a sealed projects view carries
  in memory until the first write seals it there
  (`hydrateProjectsFromVfs` keeps known names over the boot view).
- The old dropdown's silent shared-key create keeps working from the prompt;
  the choice lives in Settings → Vaults.
