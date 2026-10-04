# ADR 0161 — Tutorial mode: a tour you walk, one step at a time

- Status: Accepted
- Date: 2026-10-04
- Amends: [ADR 0088](0088-ai-native-contextual-support.md) §1 and §4 (the
  authored budget, and what draws a step). It does not widen the language.
- Builds on: [ADR 0065](0065-agent-surface-parity.md) (ceremonies stay human),
  [ADR 0130](0130-operator-controlled-capability-composition.md) (every
  feature is a capability), [ADR 0149](0149-nothing-stored-in-the-clear.md)
  (nothing the client stores rests in the clear)

## Context

ADR 0088 built a safe way for support to point at the app, and a walkthrough
was the thing it produced: a short GuideLang program that highlighted a
control and waited for the person to press it. In use that was not a
tutorial. The runtime treated a program as a trajectory — run to the next
observation boundary and stop — and the panel closed while it ran, so:

- a `say` line was written to a snapshot nobody could see, because the only
  place it was drawn was the sheet that had just closed;
- the highlight was a bare popover with no step count, no Next and no Back,
  so a person could neither read at their own pace nor go on without doing
  the thing pointed at, and a guide that ended on a `wait` simply stopped;
- a control that was not on screen failed the whole guide with
  `TARGET_NOT_MOUNTED`, which a person met as nothing happening;
- most guides were two or three instructions, because a program was capped at
  eight, and there was no list anywhere of what could be replayed.

## Decision

### 1. A run has a mode, and a tour is paced by the person

`GuideRuntime.start(program, { mode, limits })` takes a mode. `auto` is
unchanged: a model's trajectory, every wait with a deadline. `tour` is a
person walking a tutorial:

- a program is read as **steps** (`planGuideSteps`): a `say`, a pointing
  directive with the `wait` on its own target, or the closing `success`. The
  `navigate`, `scroll` and `wait`s between steps are the next step's
  preamble and run by themselves — nobody presses Next to change screens;
- each step holds until the person says **Next**; doing the thing the step
  points at also advances ("your move"), and Next advances either way;
- **Back** returns to the previous step and restores the screen that step
  expects; **Replay** begins again from the closing card; **Exit** cancels;
- nothing times out on somebody reading, and a control that is not on screen
  after a short grace period degrades the step to text with that fact on the
  card, instead of failing the guide;
- a command is delivered only to a step that is listening. A press that
  arrives while a step is still being drawn is dropped, never remembered, so a
  double press cannot skip a step nobody read.

This adds no authority. The directives are the same ten, `checkProgram` runs
before a tour starts, and Next is the person's command arriving at the
runtime: it still cannot click, type, submit or fetch.

### 2. An authored tour may be longer than a model's trajectory

A model's program stops at an observation boundary and replans, so eight
instructions is generous for it. A tutorial is the other shape — seven steps
spend fourteen instructions — so `AUTHORED_GUIDE_LIMITS` raises only the
*size* (40 instructions, 96 lines, 16 KiB). The grammar, the vocabulary
check, the 500-character text budget and the timeout range are unchanged.
The engine's origin chooses the budget: `compileAuthored` and `runGuide(…,
"authored")` use it; model output goes through `compile` and never reaches it.
The runtime re-checks the budget the program was started under.

### 3. Tutorial mode draws itself, from the runtime's own snapshot

The runtime publishes each step as data (`GuideTourView`: text, target id,
preferred side, whether it is an action, whether it is degraded). `CoachHud`
draws it and is the only thing that does: the page dims, one control stays
lit inside an accent ring, and a card carries the tutorial's name, "Step 2 of
5", a segmented meter, the sentence, and Back / Next (Replay / Done on the
closing card). Authored and model text reach the document as React text
nodes; the card parses no markup, and a control is found only through the
target registry's resolver. Driver.js is no longer used for tours, so a
`GuideRenderer` for the browser has one job left — scrolling the control into
view — and the walkthrough strip that lived inside the Support sheet is gone,
because the sheet is closed while a tutorial runs.

The HUD is **not a modal**: the aperture passes clicks to the lit control, Tab
leaves the card for the page, and the card owns only the keys that belong to
a tour — Escape exits (except from a text field, where it is the field's own
way out), and the arrow keys step it while the caret is in the card. Focus
moves to the card when a tour starts and goes back to where it was when the
tour ends; in between it moves only if it was already the card's.

On a phone (`max-width: 900px` or a coarse pointer) the card is a sheet docked
to the screen edge the lit control is *not* on, and its keys are 44px.

### 4. Every feature has a replayable tutorial, and the library lists them

The Support sheet gains a **Tutorials** tab beside Ask: every live tutorial,
grouped by what a person wants to do (`areas.ts`), each row a title, a step
count and a start key. Starting one is replaying it. A tutorial written for a
gate — unlock, setup, the broker popup — is offered only while the person is on
that gate, because a guide may wait on an overlay route and never navigate to
it. Every section of Settings › Capabilities is a `feature.*` target, every one
has a tutorial (`FEATURE_TUTORIALS`), and `areas.test.ts` fails a goal with no
home or a feature with no tour.

### 5. `verify:tutorials` walks every tutorial in a real browser

The unit tests prove the runtime and the card; `pnpm --filter
@opensesame/pages verify:tutorials` proves the product. It starts each
tutorial from the library, gets through it with Next alone (mouse on one
step, keyboard on the next), and fails on any step whose card is outside the
viewport, whose Next is missing, whose control is not lit, uncovered and
reachable through the aperture, or whose control is missing. It then goes
Back, Replays, finishes with Done and checks that focus was handed back. It
runs at desktop and phone width, with every optional capability on, and it
sits in the required Bundle budgets job.

## Consequences

- A tutorial is something a person can finish. The cost is that a step which
  points at the result of a click is shown without its spotlight if the person
  skipped the click; authored tours are written so that every step is
  reachable by navigation alone, and the browser suite enforces it.
- `GuideRuntimeSnapshot` gains `tour`, and the runtime gains `next`, `back`
  and `restart`. `auto` mode and every existing test of it are untouched.
- Widening GuideLang is still an ADR, and this is not one: no directive was
  added, and none of the ten can act.
- The transcript stays memory only. Which tutorials a person has finished is
  not recorded; a library that remembered would be a record of what somebody
  could not work out on their own.
