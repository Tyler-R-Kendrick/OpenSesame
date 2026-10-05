# ADR 0165 — A help key on the screens in front of the shell

- Status: Accepted
- Date: 2026-10-05
- Amends: [ADR 0090](0090-static-frontend-complete-without-backend.md) (the
  first screen carries one help key beside its own chrome, and still nothing
  in front of its content), [ADR 0163](0163-tutorial-mode.md) §4 and §5 (gate
  tutorials exist, and `verify:tutorials` walks them)
- Builds on: [ADR 0088](0088-ai-native-contextual-support.md) (support points
  and never acts), [ADR 0130](0130-operator-controlled-capability-composition.md)
  (an optional capability loads only after consent),
  [ADR 0149](0149-nothing-stored-in-the-clear.md) (nothing the client stores
  rests in the clear), [ADR 0150](0150-live-sessions-browser-to-browser.md) §1
  (the front door)

## Context

ADR 0163 gave every feature a replayable tutorial and left the gates without
one. The Support sheet is mounted only in the unlocked shell, and ADR 0090
forbids putting anything in front of the first screen, so the front door,
unlock, sign-in, setup, join, the broker popup and the federation return had
written help and nothing to start a tour from. `coverage-ledger.ts` named
thirteen controls on those screens as debt for exactly that reason ("its tour
needs the gate help launcher"), and a person who is stuck at the front door —
the screen with the least context of any — had the least help.

## Decision

### 1. One icon key, in the screen's own chrome row

Each gate screen draws a **seat** (`GateHelpSeat`, `tutorial/gate-seat.tsx`)
in the chrome row it already has, beside the keys that are already there: the
theme key on the front door and the unlock form, the wordmark on setup, the
brand line on the broker popup and the federation return. The Support key is
portalled into the seat. It is:

- one key, an icon (`IconHelp`) with `aria-label` and `title` "Support" — the
  shell's mark, the same name, the same glyph. An action that executes is an
  icon key (AGENTS.md §5, `docs/design/controls.md`); no verb is painted;
- a flex item in the chrome row, never a fixed layer, so it cannot rest on a
  control or on the screen's content, and never between the first screen and
  its two roads or the guest Skip. On the door it sits at the top left of the
  card, Skip keeps the top right;
- the same size as the keys beside it: 32px, and 44px on a coarse pointer or
  below 900px (the touch floor, `verify:mobile`);
- reachable by Tab like any key, and never given focus on arrival: a screen
  lands its own focus (the door's first road, the unlock field), and opening
  the sheet is the person's press;
- absent where no seat is drawn. A screen with no tour does not draw a seat,
  and nothing floats in a corner in its place.

The join screens (the Host invite and the live-join review) and `/live` draw no
seat: their controls are the codes and the carrier, and the tour for joining
points at the door's road before the person is there. A device that arrives
through a shared link therefore has no help key on those screens.

### 2. It opens the same sheet, offline

The key opens the Support sheet unchanged — Ask and Tutorials, the same
`SupportPanel`, the same library read through the same `useTutorialGate`, the
same tour card. It is **not** a second sheet. What differs is what it is given:

- the controller is built `offline`: the engine asks no agent loader for
  anything, so there is no on-device model to download, no configured endpoint
  to send a question to, and no transport but `none`. Ask is the written help,
  searched on the device; a model's answers are the shell's;
- the runtime gets a navigator that goes nowhere. A gate has no section to move
  to (`GUIDE_OVERLAY_ROUTES`), so a tour there points and waits;
- nothing is requested from the network, nothing is written to storage (the
  transcript is memory, as everywhere), and the mounted-target registry is not
  wiped when the controller goes (the unlock that ends the gate mounts the
  shell's targets in the same commit).

### 3. Gates are routes, and a tour is scoped to the one it can be walked on

A gate that is several screens in one component reports which it is.
`useSupportRoute` already named `/unlock`, `/setup`, `/broker/authorize` and
`/federation`; the screens now name the part: `/unlock/door`, `/unlock/signin`
(first run's provider panel and the local seal), `/unlock/form` (a typed key),
`/unlock/passkey` (the passkey tab picked), `/setup/choose` and, for the tabs
that have a tour, `/setup/capabilities`, `/setup/identity` and
`/setup/connectors`. A parent still scopes what is true of all its children
(`guideRouteWithin`), so a written answer or a control scoped to `/unlock`
applies in each.

`tutorialStartsFrom` is rewritten for this. From the shell it is unchanged — a
tour navigates where it is going — except that a goal naming only gates is not
offered, because the shell cannot walk it. At a gate it offers **exactly the
tutorials written for that gate** and none of the shell's, whose controls the
screen does not draw. `scopeApplies` states the same rule for targets, written
help and the goals a model is told about: no scope means the shell, and a gate
is not the shell. `areas.test.ts` no longer asserts that nothing is offered at
a gate; it asserts this rule, and that every gate that draws a key offers at
least one tutorial.

### 4. Optional code, consent and authority

The key is drawn by `support.guided-help`, an always-on capability (ADR
0135, 0142), through the `Gate` part of its shell-wrapper contribution. The
core owns the seat, the route the screen declares and an always-present
`GateHost` around every non-shell screen; the capability's `SupportGate` is
drawn **beside** the screen, not around it. So a capability arriving after the
first paint, or an operator's policy withdrawing it, cannot remount the screen
— a remount would drop what a person had typed — and a build without the
capability draws an empty seat of no width. Nothing optional loads before
consent: the sheet, the tour card and the guide runtime stay behind
`import()` and arrive on the first press, exactly as in the shell. The key adds
no authority. A tour can still only say and point (ADR 0088); it cannot click,
type, submit, fetch or navigate. Written help that names a tour belonging to
another screen shows its answer and no Show me.

### 5. The broker popup and the federation return

The broker popup is a top-level window of this origin, not a frame, so it can
host the sheet: the sheet is a fixed layer no wider than the window, and the
popup's own consent card is untouched. The seat is in the header line, away
from Allow, Deny and Use a different account; the tour points at the card and
describes them and does not press them. The federation return is a transient
screen (Finishing sign-in…, or the failure card with Back to sign-in): the key
is drawn in both, and its tour describes the screen and the failure card.
Neither screen's controls, messages to the opener or navigation change.

### 6. `verify:tutorials` walks the gates

`pnpm --filter @opensesame/pages verify:tutorials` gains a gate pass at both
widths: the door, setup (the choice, then each tab that has a tour), sign-in
and the seal, unlock (a typed key, the passkey tab, the account menu), and — in
the context the shell pass switches every capability on in — the broker popup
and the federation return, each reached the way a person reaches it. Each
gate's key is held to this ADR (one key, named and titled, the 44px floor on a
phone, in the screen's chrome, resting on no control, reachable by Tab, never
holding the focus on arrival, and the guest Skip still there), and every
tutorial it offers is walked exactly as a shell tutorial is, starting from the
key. The shell's library is checked to offer none of the gates'.

## Consequences

- Thirteen ledger lines are deleted (`unlock.signin`, `unlock.setup`,
  `unlock.account`, `unlock.submit`, `unlock.secret`, `unlock.passkey`,
  `setup.ways`, `setup.connectors`, `setup.join`, `setup.keep`,
  `setup.finish`, `broker.consent`, `federation.return`), and five targets are
  added and taught (`unlock.methods`, `unlock.guest`, `unlock.local-only`,
  `setup.configurations`, `setup.tabs`). The ledger only falls.
- Eight guide routes are added. The page context carries at most 32; the
  authored set is at 27, so a later gate's route should be weighed against the
  budget (`SUPPORT_LIMITS.maxRoutes`).
- Written help for a gate (`help.unlock`, `help.setup`) names its tour where
  its screen can start one.
- `ShellWrapperContribution` gains an optional `Gate`. No other capability
  uses it.
- A gate tutorial that points at a control a state does not draw (a passkey tab
  on a vault with none, the keep offer where the browser will not install) is
  withheld by its route or by a `requires`, not shown with a missing control.
- The key is a small thing on the screen that matters most. It is not a
  tutorial prompt: it does not open itself, does not badge, and is not drawn
  where there is nothing to open.
