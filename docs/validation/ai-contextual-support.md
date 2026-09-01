# AI-native contextual support — validation

What was actually run for the in-product support assistant and the adaptive
tutorial system ([ADR 0088](../adr/0088-ai-native-contextual-support.md),
[architecture](../architecture/ai-contextual-support.md)), what each command
proves, and — the part that matters more — what it does not.

This document is the test inventory. The threat-by-threat review of the same
subsystem — what was attacked, what held, and which properties are structural
rather than conventional — is
[`audit-2026-08-31-ai-contextual-support.md`](../security/audit-2026-08-31-ai-contextual-support.md).

The design's whole claim is that a compromised model cannot do damage because
the grammar has no way to express damage. That claim is structural, so it is
testable, and most of it is tested below — including an adversarial suite that
scripts the worst model output we could think of and drives it through the
assembled chain.

What is deliberately **not** claimed is that any model resists prompt
injection. No suite here evaluates a model's behaviour, because the
architecture does not depend on it; what is demonstrated is the blast radius,
not the likelihood. If a reader takes one thing from this document, it should
be the residual gaps rather than the pass counts.

## `pnpm --filter @opensesame/guide-lang test`

**Proves.** The language is what ADR 0088 §1 says it is.

`parse.test.ts` walks the grammar: header and goal placement, every wait
subject, the budgets at their exact limits, and a case per declared diagnostic
code with a meta-test asserting every code in `GUIDE_PARSE_ERROR_CODES` is
reachable from some input. It asserts directly that directives outside the
grammar — `click`, `type`, `eval`, `selector` and the rest — are rejected as
unknown; that a route that is `javascript:`, protocol-relative, external or
traversing fails; that a target id shaped like a CSS selector fails; that a
`wait` without `timeout=` fails and one outside [250 ms, 60 s] fails; and that
markup in a message stays inert prose and can never become a directive. A
dedicated block proves **no runnable prefix**: a program whose later line is
outside the grammar yields no program at all, including when the valid prefix
is long. Text handling is covered for astral-plane characters, escaped and raw
lone surrogates, bidi overrides, zero-width space, NUL, and the fact that
message length is counted in code points rather than UTF-16 units.

`property.test.ts` is the fast-check half. Over arbitrary input, `parseGuide`
never throws and never accepts text that does not start with the header; over
text shaped like a program it never throws; and no accepted program ever
carries a target, route, predicate or goal that the corresponding id validator
rejects, or a message carrying a forbidden character.

`serialize.test.ts` pins canonical output: every instruction round-trips,
named arguments are ordered identically every time, serialization is stable
across repetition, and two equal programs built differently produce the same
text.

`validate.test.ts` separates the two questions the architecture doc's §5
describes: a syntactically valid but unregistered route is a *validation*
failure, while an unusable route is a *parse* failure caught before the
vocabulary is consulted at all.

**Residual gap.** The parser has no coverage-guided fuzz target in `fuzz/` or
`packages/fuzz/`; fast-check is property testing with generators we wrote.
Unicode is asserted at the specific hazards, not exhaustively. Nothing here is
in the `stryker.config.json` mutation slice, so a surviving mutant in the
parser would not currently fail a gate.

## `pnpm --filter @opensesame/guide-runtime test`

**Proves.** The runtime re-derives its own safety rather than trusting the
compiler. `runtime.test.ts` feeds it programs a parser would never have emitted
— over the instruction budget, over the message budget, outside the timeout
bounds, naming an undeclared target, route or predicate — and asserts each
fails closed with the matching `GuideRuntimeErrorCode` instead of reaching a
port. A *known* target that is not mounted is refused rather than pointed at.

The lifecycle rules are covered behaviourally: starting a run supersedes the
one in flight and its stale continuation is ignored; cancelling for a lock
clears the overlays and survives an observation arriving late; `pause` leaves
overlays standing while `end` tears them down; pause and cancel are idempotent
and safe when idle; every settle path completes without an unhandled rejection;
a renderer that throws settles rather than propagating; and a completed run
leaves no armed deadline and no abort listener behind. Waits are proved on all
three subjects — a target activation, an arrival at a route, a predicate flip —
and a wait that can no longer be observed stops at an observation boundary
rather than hanging.

`clock.test.ts` covers both clocks: the system clock resolves on its deadline
and clears its timer when abandoned, the test clock settles only once time has
passed and disarms on abort, and neither settles for an already-aborted signal.
`runtime.property.test.ts` asserts over generated trajectories that the runtime
never renders more than the trajectory asked for.

**Residual gap.** Every deadline comes from `createTestClock()`, so what is
proved is the state machine's logic, not real timer behaviour. The ports are
`fakes.ts` recorders, so this suite says nothing about the browser adapters.
There is no concurrency model-checker for TypeScript here (no Shuttle
analogue), so interleavings beyond the ones the suite scripts are unexamined.

## `pnpm --filter @opensesame/support-agent test`

**Proves.** `egress.test.ts` exercises the last code that runs before anything
reaches a model. The sanitizer **rebuilds** rather than copies — mutating the
input afterwards is invisible in the output — and refuses, rather than strips,
an element-like object anywhere in the payload, a function, a payload carrying
a password, a vault-record-like payload, an unexpected key even when it looks
harmless, a missing key rather than sending partial context, an undeclared
target role, an accessor rather than invoking it, a reference cycle, and a host
type masquerading as data. Every denylisted key term is refused however it is
spelled, and a refusal names the field but never the value. The budget clamps
are asserted separately, including that an over-long identifier is *refused*
rather than truncated into a different valid identifier.

`turn.test.ts` covers model-output handling: prose is split from a fenced guide
block, a fence that is not a guide is ignored, a bare fence opening with the
version header is accepted, an unfenced line-anchored program is accepted,
garbage never throws, and the answer is clamped. On the run path it proves the
answer survives a guide that never compiles; that repair happens **exactly
once**; that the repair call sends the diagnostic codes and not the rejected
program; that an aborted caller is not retried; that the answer survives a
failed repair; and that a request failing the egress boundary is not sent at
all.

`session.test.ts` proves the conversation rules: questions and answers recorded
in order, an empty question ignored, a superseded answer discarded, a cancelled
ask dropped, an unavailable agent reported without an invented answer, a
transport failure surfaced as a code rather than as prose, clearing the
transcript without dropping the provider session, and `destroy()` emptying the
transcript and destroying the port.

`instructions.test.ts` is the characterization suite over the system
instruction: every clause in `SUPPORT_POLICY_CLAUSES` appears verbatim in the
built instructions, including when the page context is empty, so a security
clause cannot evaporate in a rewrite of the surrounding prose. It also asserts
the instruction names exactly the identifiers the context supplied and drops
one once the context stops offering it.

`fake.test.ts` covers the shared test double itself, including that it can
reach the awkward provider states other suites depend on.

**Residual gap.** The instruction suite proves the *text* is present. It cannot
prove a model obeys it, and is not meant to. Nothing here exercises a real
provider.

## `pnpm --filter @opensesame/pages test`

This command runs the whole `apps/pages` suite. The parts belonging to this
work are below.

**The registries.** `tutorial/registry/catalog.test.ts` holds the invariants
that make the catalog safe to hand to a model: every control has a unique
semantic id within budget, every target is scoped to routes the route registry
actually declares, every cited capability exists in the ADR 0065 registry, and
— the load-bearing one — no description and no authored help answer could
interpolate a user-created value. It also asserts the page context describes
targets without leaking an element, a closure or an extra field; that the
authored guides **compile against the live registries** through the same
pipeline model output uses; that goal ids are semantic and unique and are the
only goals help topics point at; and that mount bookkeeping records no
duplicate for an ordinary mount and unmount, refuses the same element twice,
refuses an id the catalog never declared, resolves a target to whichever
candidate is visible, and does not call a hidden control mounted.

`tutorial/registry/context.test.ts` covers the one input the context builder is
handed: a registered route passes through unchanged, a route the registry does
not declare is refused and reduced to `/vault`, and targets and goals are scoped
to the corrected route rather than the supplied one. These cases exist because
the adversarial sweep found `route` arriving as a caller-supplied string that
the egress sanitizer bounded in length but never checked for membership —
correct only because the single live caller happens to pass a total function.

`tutorial/registry/predicates.test.ts` proves every predicate is declared
exactly once, that re-declaring is safe, that each one answers a boolean **while
the vault is locked** (a predicate that threw would take a guide down with it),
that location is reported through the route registry rather than the raw path,
that connections report only a count and never anything named, and that an
undeclared id is refused.

`tutorial/registry/instrumentation.test.tsx` renders the instrumented screens
and asserts the bindings actually attach — the connector catalog, its search
field, the custom-connector link, the connected panel, the health verdict and
its findings, the two authority planes on the statusline, the core connections
panel in Settings — that they drop on unmount, and that no semantic id is ever
mounted twice across all of them.

**Rendering.** `tutorial/rendering/driver-xss.test.ts` is the load-bearing
suite. It runs in jsdom **against the real Driver.js 1.8.0**, not a stand-in,
because the hazard is that the shipped library fills the popover description
with `innerHTML` — a fake that recorded the string would prove nothing. Four
classic payloads (`<img src=x onerror=…>`, `<script>`, a `javascript:` href,
`<svg onload=…>`) go through a focus popover, a hint popover and an annotation
and each appears as literal text. It also asserts the popover title comes from
authored text and never from the message, that `clear()` leaves no overlay,
popover, beacon or annotation behind, that the page stays keyboard-operable and
Escape-dismissible, and that the library and its stylesheets load on demand.

`driver-renderer.test.ts` covers the adapter: text written even though the slot
is an HTML sink, reduced motion honoured, an unmounted target rendering nothing
and recording the miss, no node left after `clear()`, annotation without a
modal and without taking the caret, the caret preserved for a hint and handed
over for a focus, and scrolling that tolerates a host that cannot scroll.
`rendering-contract.test.ts` asserts Driver.js is absent from the static import
graph, that the module exports OpenSesame values only, and that every
stylesheet rule is scoped to the guide.

**The on-device provider.** `tutorial/agents/prompt-api/*.test.ts` drives the
Prompt API through an **injected fake platform object**: availability
normalized across every platform state, download progress clamped to a
fraction, a created session that cannot be prompted rejected, abort discarding
a late answer, one bounded session recreation when context runs out, session
reuse across turns, and — the two that matter for privacy — that what leaves
carries the policy instructions and the authored page context, and that it
never carries page text or stored values the context did not authorize.

**The remote provider.** `tutorial/agents/ag-ui/endpoint.test.ts` and
`endpoint-same-origin.test.ts` hold the egress fence: https anywhere, http only
on loopback or this page's own origin, cleartext to a third party refused,
non-transport schemes refused, a scheme-relative reference refused rather than
inheriting our origin, embedded credentials, a query and a fragment refused,
non-URLs refused, headers carrying content negotiation and no credential, and
the transport left off when config is absent or refused.

`ag-ui-agent.test.ts` covers both directions. Outbound: a planted element, a
planted function and a planted password are each refused **before the transport
is called**, and the body is exactly the allow-listed structure. Inbound, under
hostile server events: a tool call is ignored and only assistant prose kept; a
state patch carrying a `javascript:` route is ignored; a messages snapshot is
ignored; deltas for a non-assistant role are dropped; an oversized payload is
capped; a stream that ends without an assistant message, and an empty stream,
are refused; malformed non-object events are survived; a server-authored error
message is never surfaced; and a connection failure is reported without
repeating what the transport said. A guide containing a forbidden directive is
handed to the compiler to reject rather than special-cased. Abort ends as
`AGENT_ABORTED` and stops pulling stale events, an already-aborted signal is
refused, and `destroy()` aborts the run in flight.

`transport.test.ts` proves the POST carries no ambient credentials and follows
no redirect, that a non-200 is refused before any event is decoded, that a
connection failure surfaces as a stream error, and that an already-cancelled
run makes no request at all. `bundle-hygiene.test.ts` asserts the library is
named as a module specifier only inside a dynamic import, that the one dynamic
import still exists so the rule is not vacuous, that nothing in the directory
logs, and that the exported surface carries no AG-UI or rxjs type names.

**The panel.** `tutorial/ui/support-hygiene.test.ts` is a source-oracle sweep
over the whole support surface: model text reaches the document only as text,
a support conversation is never persisted, and it is never logged. It first
asserts that it covers the whole surface, so a new file in the directory cannot
quietly escape the sweep.

`tutorial/ui/support.test.tsx` covers the surface a person
touches: it opens from the statusline and returns focus on close, closes on
Escape without the vault keymap acting on the key, renders an answer as text
and markup in an answer as *literal* text, still opens and helps when nothing
can answer, answers an authored topic and launches a named walkthrough **with
no model at all**, offers the model download only as a gesture and reports its
progress, cancels an in-flight question, shows the remote-transport warning
exactly when answers leave the device and not otherwise, clears the
conversation on request, and drops the transcript, the guide and the panel when
the vault locks. An accessibility block asserts the affordance and the dialog
are named and that Tab stays inside the dialog.

**The assembled chain, attacked.**
`tutorial/__tests__/adversarial/` is the set of suites that assemble the real
page context, the real compiler, the real registries and the real runtime
together and then attack the seams between them. Every other suite drives one
component against fakes for its neighbours, which is right for those suites and
is exactly why the wiring is the least-observed part of the feature: a
component can satisfy its own contract while the wiring around it quietly
widens what reaches the DOM. The shared harness offers two observation points
— what the renderer was asked to draw and where the router was asked to go — so
an attack that leaves both empty left no trace on the page.

`injection-chain.test.ts` drives a hostile model end to end and, crucially,
*runs* whatever comes back, because a test that only asserted "did not compile"
would not notice a caller that ran the program anyway. Nine hostile programs —
`click "#reveal-secret"`, `navigate "javascript:alert(1)"`, an off-origin
navigate, an id selector and a descendant selector in `focus`, `eval`,
`execute-tool`, an unbounded wait on an invented target, and a four-hundred
instruction program — each draw nothing and go nowhere. It also proves the
prose answer survives, that exactly one repair is asked, that the rejected
program is never repeated back to the model, that an application-authored guide
*does* draw and navigate (so the negative assertions are not vacuous), that no
directive in `GUIDE_INSTRUCTION_NAMES` could click, type, fetch or evaluate,
and — over fast-check input — that no arbitrary string becomes a target the
compiler accepts and the registry resolves, or a route, or a predicate.

`context-leak.test.ts` populates a vault with attacker-shaped text — item
names, folder names, connection labels, KDBX-imported entries — and asserts
none of it reaches the assembled page context on any route the tutorial can
name, the system instruction, the body an AG-UI endpoint would receive, the
request a provider is handed, or the popover a person reads. It also proves the
vault really is populated so the assertion bites, that each target carries only
registry-authored fields and no element, that connections report a count rather
than a label, and that attaching a vault record to a request is refused
outright. The registry suite makes the same claim about the catalog's *source*;
this one makes it about a running vault.

`lock-teardown.test.ts` locks at the four awkward moments, against a provider
that deliberately ignores its abort signal: with a model request in flight (the
transcript empties and the late answer renders nothing), with an armed wait and
its deadline and overlays up, with a highlight left standing by a pause, with a
persistent annotation that outlives its own step, and afterwards — a guide
compiled before the lock cannot drive the page again. Four owners of state have
to be reached by one lock — the controller, the support session, the target
registry and Driver's own overlays — and only a suite that drives the
composition can see whether it reaches all four.

`stale-chains.test.ts` covers work that arrives after the world it was planned
for has gone. Both halves of this feature are asynchronous against a page that
moves: a model answers on its own schedule, and a trajectory is compiled
against the vocabulary of the route the person was on when they asked. The
session suite proves a superseded *answer* is dropped; this one proves the
guide attached to that answer is dropped with it, that a program compiled for
one route does not compile once the page has moved, that one compiled before
the move fails closed rather than drawing, and that starting a second
walkthrough cancels the run in flight rather than drawing over it.

`renderer-inertness.test.ts` drives markup from a raw model completion all the
way to the glass. `driver-xss.test.ts` hands payloads straight to the renderer,
which proves the adapter; it does not prove the chain, because a completion has
to survive `parseSupportTurn`'s fence handling, the compiler's string literals,
the runtime's message checks and the port hop first, and each of those touches
the string. This one runs the whole path with the real library and then asserts
on the document: markup stays literal text in a focus popover, an annotation
and a hint, the popover is named by us and never by the message, and it carries
no text from the control it points at.

`registry-integrity.test.ts` attacks the registries through the app's own
compile and run edges rather than a hand-written vocabulary: an identifier this
build does not declare is rejected with the code naming what was missing; a
well-formed but unregistered route is refused by the registry, the compiler and
the runtime alike, and never appears as the route the page reports for any
path; a second element cannot take the binding from the one already on screen;
the same element mounted twice is recorded or refused rather than silently
duplicated; and a target that leaves the page mid-walkthrough stops the
trajectory instead of pointing at nothing. It also exercises the
runtime with a program handed in as an AST — the path a parser bug, or any
future caller that builds a program itself, would take.

`webmcp-boundary.test.ts` attacks the wall ADR 0088 §8 puts between guidance
and actuation, which the WebMCP suites and the AG-UI suite each test only on
their own terms — what neither covers is the pair, live in one document, with a
hostile stream naming a real tool. It proves no export of the WebMCP package
runs a tool, that a tool listing is metadata holding no callable, that
`opensesame_guide_start` accepts nothing but an id somebody in this repository
authored and refuses GuideLang however it is dressed up, that starting an
authored goal returns only its id, and that a hostile AG-UI stream can neither
reach a WebMCP tool nor obtain a catalog to name one from — while the guide it
carries still faces the compiler like any other.

**Accessibility.** `tutorial/__tests__/a11y/` drives the panel with a real
Driver.js adapter over a stand-in that reproduces the two library behaviours
that matter — both popover slots written as `innerHTML` before the render hook
runs — because questions about who holds the caret and what a callout *is* are
questions about what the adapter puts in the document, which a recording
renderer cannot answer.

`dialog-semantics.test.tsx` asks for every control by its accessible name
rather than by class or selector, on the reasoning that the panel is a
`<section>` wearing `role="dialog"` and its name lives in an attribute a
refactor can silently drop. It asserts the launcher is named and says what it
opens, that one modal dialog opens named, headed and closable, that the scrim
sits outside the dialog's reading order, that every field is labelled
programmatically rather than by placeholder, that each region of the sheet is
named so it can be reached by landmark, that no positive `tabindex` appears,
and that a live walkthrough is announced in the launcher's name rather than
only in its colour.

`focus-and-escape.test.tsx` covers the parts the app wrote itself, because the
panel is not a native `<dialog>`: the caret lands on the dialog's own close
control rather than merely inside it, the launcher is restored after both
Escape and the scrim, Tab wraps in both directions and stray focus is pulled
back in. It also covers the collision that makes Escape interesting here — the
vault keymap owns every unmodified key on the page underneath, and Escape there
is `closeSearch` — proving the sheet closes without the keymap acting and
without locking, and that no other vault key fires while the sheet is up.

`announcements.test.tsx` asks what somebody who cannot see the panel is told,
on the reasoning that four of this feature's states are the kind that get built
as pure visual texture — a caret for "thinking", a bar for a download, a red
rule for a failure, a tinted card for a live walkthrough — and a state a screen
reader cannot reach is a state that does not exist for the person who most
needs the panel to work. It asserts thinking is said in words in a live status
beside a way out, download progress is text and not only a bar, the download is
a named gesture rather than an ambient fetch, the unavailable state is labelled
in prose with the unusable field disabled, a failure is raised as an alert in a
sentence with no error code in it, an answer lands in a named polite live
region, a walkthrough's progress and paused state are said in words, and the
remote-transport warning is named as text.

`keyboard-operability.test.tsx` tabs to each control the way a person would and
activates it with Enter, rather than calling `.focus()`, which proves nothing
about tab order: opening and closing, asking and receiving an answer,
cancelling a question in flight, clearing the conversation, opening a written
help topic on a browser with no model, searching the written help and starting
a walkthrough — and a sweep asserting the sheet offers nothing that only a
pointer can use.

`stylesheet-contract.test.ts` reads the two stylesheets as data and asserts
they cannot reach past this feature: every `support.css` rule is anchored on
the panel's own scope and every `driver.css` rule on the adapter's marker or a
Driver class, neither anchors on a shared control or a bare element, a shared
control is reached only from inside the panel, and the reduced-motion block
neutralises every animation each stylesheet starts and moves nothing on a
transition.

`reflow.test.tsx` covers the structural half of a narrow viewport and is candid
in its own header about the other half: jsdom performs no layout, so no media
query is evaluated and nothing can overflow, and nothing there can show the
panel is legible at 320 CSS pixels or at 400% zoom. What it does prove is what
actually breaks — no control is dropped or hidden when the window narrows to a
phone, the way out and the way in stay outside the region that scrolls, and a
2,000-character unbroken answer leaves every control reachable.

`guide-motion-and-focus.test.tsx` covers the composition rather than the
adapter, which `driver-renderer.test.ts` already holds: a walkthrough starts on
the live page with the sheet closing itself behind it, reduced motion carries
through the panel into both the spotlight and a hint beacon, the caret goes to
the highlighted control rather than to the overlay and can leave it again — the
guide points, it does not trap — and a whole walkthrough of annotations and
hints never takes the caret at all.

**The journeys the feature exists for.**
`tutorial/__tests__/journeys/connections.test.tsx` drives adding a provider
connection as the replan loop rather than as a script that plays to the end:
the guide points at Connections, waits for the person, stops at the observation
boundary, and the next trajectory is planned from where they actually got to.
Its second story is the one that matters most — the person arrives their own
way rather than by taking the highlight, and the walkthrough advances anyway,
because the runtime is supposed not to care how they got there. A tour would
have broken at exactly that point.

The rest of that directory covers the journeys either side of the happy one.
`health-and-lock.test.tsx` walks the two-part health answer — the planes on the
statusline, then the report on the items — and highlights the lock while
leaving it alone, which is the guidance-not-actuation rule seen from the
person's side. `no-model.test.tsx` and `phone.test.tsx` run the same ground
with no model available and on a narrow viewport where a target resolves to its
other candidate. `refused-walkthrough.test.tsx` is the failure a person meets:
the answer is kept, the walkthrough is said not to have run, and nothing is
drawn. `vault-locks.test.tsx` locks while support is busy and asserts the
conversation, the walkthrough and the overlays go together.

**Agent surface.** `webmcp/registry-parity.test.ts` holds the ADR 0065 line:
the implemented pages catalog equals the registry-derived one, the guidance
tools are session-scoped and carry the capabilities the registry names
(`client.support`, `client.tutorial`), neither trips the secret-name fence,
`opensesame_help` opens only on an authored topic and rejects one nobody
authored, `opensesame_guide_start` starts a named goal and **refuses an unnamed
goal and any GuideLang text**, and both return only a fixed status plus the
authored id they were given.

**Residual gap.** jsdom is not a browser. Layout, scroll, focus ring and
overlay geometry are approximated, so "the highlight lands on the right
control, visibly" is not proved. **No live on-device model runs anywhere in
this suite** — the Prompt API is reached through an injected fake, and the API
shape we bind to is our reading of it rather than something a browser confirmed
in CI. `@ag-ui/client` itself is never loaded by a test; the transport suite
drives a fake client, which is the intended consequence of the dynamic import
but does mean the real library's event decoding is unexercised here. No test
speaks to a real AG-UI server.

## The WebMCP and capability-registry suites

`pnpm --filter @opensesame/webmcp test`,
`pnpm --filter @opensesame/capability-registry test`

**Proves.** The WebMCP package probes `document.modelContext` first and the
legacy `navigator.modelContext` second, normalizes both, and no-ops when
neither is present. Names without the `opensesame_` prefix are rejected, and
secret-shaped names are rejected through the registry denylist even with no API
present. Errors cross to an agent as scrubbed one-line text with no `Error`
internals, and a result that still looks like a credential is refused.
`index.test.ts` asserts the package exports **no generic tool-execution
function** and keeps `executeTool` unreachable even when the browser implements
it. The capability-registry self-tests hold the ADR 0065 invariants that the
new `client.support` and `client.tutorial` capabilities now participate in.

**Residual gap.** No browser in CI implements `modelContext`, so every WebMCP
assertion is against a stand-in object of our own construction. If the draft
moves again, these tests keep passing against the shape we already support.

## The lint, typecheck and build gates

`pnpm lint:design`, `npx biome check` over the new packages and
`apps/pages/src/tutorial`, `pnpm lint:anti-slop`,
`pnpm --filter @opensesame/pages typecheck`,
`pnpm --filter @opensesame/pages build`. The integration gate runs
`npx biome check .` across the whole repository; the run recorded here was
scoped to this work's files so a formatting problem in somebody else's
in-flight code could not be reported as ours.

**Proves.** The control contract in `docs/design/controls.md` still holds for
the support panel's controls; formatting and the anti-slop rules pass on the
new sources (no `vi.mock`, no bare `typeof`, no unexplained assertions, no
`unknown` in signatures); the whole `apps/pages` graph typechecks under
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; and the app builds
with the new packages in the graph.

The build's own output was also inspected once, by hand, because the
source-graph tests (`rendering-contract.test.ts`, `bundle-hygiene.test.ts`)
prove the *imports* are dynamic and not that the bundler honoured them. In the
build measured here the entry chunk is `assets/index-*.js`; Driver.js is
emitted as its own chunk plus a separate hints chunk and two stylesheets, and
the string `driver-popover` appears in neither the entry chunk nor anything it
statically imports. The AG-UI adapter is a small separate chunk reached through
a `__vite__mapDeps` dynamic import, and the library closure that carries the
AG-UI event vocabulary is a further chunk the entry does not name at all.

**Residual gap.** That inspection is manual and one-off. Nothing in CI asserts
it, so a bundler configuration change could pull either library into the boot
chunk without failing a build or a test. A chunk-composition assertion is the
missing gate, and the hashed filenames quoted above are specific to that build
rather than stable identifiers to assert against.

## Results

Measured on 2026-08-31. Figures are verbatim from the runs; nothing here is
quoted from a run that did not happen.

| Command | Files | Tests | Outcome |
|---|---|---|---|
| `pnpm --filter @opensesame/guide-lang test` | 4 | 126 | pass |
| `pnpm --filter @opensesame/guide-runtime test` | 3 | 30 | pass |
| `pnpm --filter @opensesame/support-agent test` | 5 | 82 | pass |
| `pnpm --filter @opensesame/webmcp test` | 5 | 40 | pass |
| `pnpm --filter @opensesame/capability-registry test` | 1 | 11 | pass |
| `pnpm --filter @opensesame/pages test` | 189 | 2548 | pass |
| …narrowed to `vitest run src/tutorial src/webmcp` | 39 | 332 | pass |
| `pnpm --filter @opensesame/pages typecheck` | — | — | pass |
| `pnpm lint:design` | — | — | pass |
| `npx biome check` over the new packages and `apps/pages/src/tutorial` | — | — | pass |
| `pnpm lint:anti-slop` (repository-wide) | — | — | pass |
| `pnpm --filter @opensesame/pages build` | — | — | pass |

The `apps/pages` row is the whole application suite; the row under it is the
same suite narrowed to this work's directories, run separately so the figure is
measured rather than estimated. The two were taken some commits apart while the
adversarial, accessibility and journey suites were still being written, so the
narrowed figure is the later one and the whole-suite figure predates several of
the files the narrowed run counts. Both are quoted as measured rather than
reconciled into a number nobody ran. Every run used `env -u NODE_OPTIONS`,
which this container requires.

File counts are deliberately absent from the lint and build rows: this tree
moved under the measurement, and a count quoted from one moment reads as a
claim about another. The integration gate's whole-repository run is the
authority. `npx biome check` over these paths was re-run at the same point as
the narrowed test figure and was clean.

Two things worth recording rather than smoothing over. An early run of the
`apps/pages` suite, taken while other work was still landing, reported ten
failures across five files — all timeouts in the vault's Argon2 unlock tests
under load, none in the tutorial files; a reader who reruns under contention
may see the same thing. And the `lock-teardown` cases were red for a while
before they were green: the cause was the test's own wiring, which had not
subscribed the controller's lock handler, not a gap in teardown. Both are
recorded because a figure without its context is how a flake becomes folklore.

## What is not covered

Stated plainly, because under-claiming here is correct and over-claiming is a
defect.

**No live model, on-device or remote, is exercised anywhere.** The Prompt API
is reached through an injected fake; the AG-UI transport through a fake client
and a fake fetch. Nothing in CI proves the browser's `LanguageModel` behaves
the way `detect.ts` assumes, and nothing proves a real AG-UI server's stream
decodes.

**No model was evaluated for susceptibility to injection.** The adversarial
suite drives a *scripted* hostile agent: it proves that a model emitting the
worst output we could think of moves nothing on the page. It does not prove
anything about how easily a given model can be made to emit such output, and no
suite here measures that. That is deliberate — the security argument is that a
hostile program is rejected regardless of why it was emitted — but the
distinction is worth keeping sharp: what is demonstrated is the blast radius,
not the likelihood.

The corpus is also ours. A hand-written set of hostile programs plus
fast-check generators is not an adversary; a payload class nobody thought of is
a payload class nobody tested. Folding these cases into `packages/redteam`
alongside the existing structural pact suite would put them under the same
sweep as the other agent surfaces, and that has not been done.

**The Playwright visual and e2e suites were not run.** `pnpm test:visual` and
`pnpm test:e2e` need a served build and a browser. No pixel baseline exists for
the support panel or for a highlighted control, so a visual regression in the
overlay would not be caught — and `packages/visual-contract` is where the
browser-driven half that `reflow.test.tsx` cannot cover would go: legibility at
320 CSS pixels, behaviour at 400% zoom, and whether the popover actually lands
beside the control it names.

**No coverage or mutation figure is claimed for the new packages.**
`pnpm test:coverage` and `pnpm test:mutation` were not re-run, and none of
`guide-lang`, `guide-runtime` or `support-agent` is in the
`stryker.config.json` mutate list. Per [`test-coverage.md`](test-coverage.md)
the per-package 50% lines floor applies to any measured package, so these will
be measured the next time that gate runs; the figures in that document were not
updated here because the gate was not run.

**No fuzz target exists for the GuideLang parser.** It is the obvious
candidate — a small, dependency-free, all-or-nothing parser sitting directly on
untrusted input — and `packages/fuzz` is where a Jazzer.js target would go.

**jsdom is not a browser.** It computes no layout, so geometry, focus-ring
rendering and whether a highlight is actually visible where the popover claims
are all unproven. The XSS suite's value is that it runs the real library's
markup sink, not that it renders like Chrome.

**Accessibility is asserted by behaviour, not audited by a tool or a person.**
The suites cover naming, landmarks, labelling, focus containment and
restoration, tab order, Escape against the vault keymap, pointer-free operation
of every control, and the words each state announces. What is missing is an
automated rule sweep — there is no axe-style audit — and verification with a
real screen reader in a real browser: asserting a live region exists and
carries the right words is not the same as hearing the order and timing of what
is actually spoken as a highlight moves. Colour contrast of the overlay and the
popover is also unmeasured.

**Offline behaviour is covered by construction, not by an offline test.** The
no-model path is exercised (`answers an authored topic with no model at all`),
but nothing runs the installed PWA with the network genuinely down.
