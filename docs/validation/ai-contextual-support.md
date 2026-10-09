# AI-native contextual support — validation

What was actually run for the in-product support assistant and the adaptive
tutorial system ([ADR 0088](../adr/0088-ai-native-contextual-support.md),
[architecture](../architecture/ai-contextual-support.md)), what each command
proves, and — the part that matters more — what it does not.

> Status (2026-10-08): the run, its counts and its build inspection were
> recorded on 2026-08-31 and were not re-measured. The suites have since grown:
> `guide-lang` also has `limits.test.ts`; `guide-runtime` also has
> `tour.test.ts` and `tour-edges.test.ts`; `support-agent` also has
> `egress-terms.test.ts` and `remote-payload.test.ts`; `webmcp` has six test files against the five
> measured (`detect`, `fence.characterization`, `fence`, `index`, `registrar`,
> `registration-ack`); and `capability-registry` has six against one.
> The registry suites (`catalog`, `context`, `predicates`) now live in
> `packages/app-core/src/tutorial/registry/`.

This document is the test inventory. The threat-by-threat review of the same
subsystem — what was attacked, what held, and which properties are structural
rather than conventional — is
[`audit-2026-08-31-ai-contextual-support.md`](../security/audits/2026-08-31-ai-contextual-support.md).

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

**Residual gap.** The parser has no coverage-guided fuzz target in `tests/fuzz/cargo/` or
`tests/fuzz/jazzer/` (the Jazzer.js target `support_payload` fuzzes
`parseSupportTurn`, which splits a completion into prose and a guide block but
does not parse GuideLang); fast-check is property testing with generators we wrote.
Unicode is asserted at the specific hazards, not exhaustively. Nothing here is
in the `tools/mutation/stryker.config.json` mutation slice, so a surviving mutant in the
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

**The registries.** `catalog.test.ts` (in
`packages/app-core/src/tutorial/registry/`, so run by
`pnpm --filter @opensesame/app-core test`) holds the invariants
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

`context.test.ts` (same directory) covers the one input the context builder is
handed: a registered route passes through unchanged, a route the registry does
not declare is refused and reduced to `/vault`, and targets and goals are scoped
to the corrected route rather than the supplied one. These cases exist because
the adversarial sweep found `route` arriving as a caller-supplied string that
the egress sanitizer bounded in length but never checked for membership —
correct only because the single live caller happens to pass a total function.

`predicates.test.ts` (same directory) proves every predicate is declared
exactly once, that re-declaring is safe, that each one answers a boolean **while
the vault is locked** (a predicate that threw would take a guide down with it),
that location is reported through the route registry rather than the raw path,
that connections report only a count and never anything named, and that an
undeclared id is refused.

`apps/pages/src/tutorial/registry/instrumentation.test.tsx` renders the instrumented screens
and asserts the bindings actually attach — the connector catalog, its search
field, the custom-connector link, the connected panel, the health verdict and
its findings, the two authority planes on the statusline, the core connections
panel in Settings — that they drop on unmount, and that no semantic id is ever
mounted twice across all of them.

**Rendering.** Since ADR 0163 a walkthrough is a tutorial drawn by a React card
(`tutorial/coach/`), not a Driver.js popover, so there is no HTML sink to
defend: `__tests__/adversarial/renderer-inertness.test.ts` drives six classic
payloads (`<img src=x onerror=…>`, `<script>`, a `javascript:` href,
`<svg onload=…>`, an iframe, a style escape) from a raw model completion,
through `parseSupportTurn`, the compiler, the runtime and the controller, to
the real card — as a focus, an annotate and a hint step — and each appears as
literal text with no element made from it. It also asserts the card is named
by the goal's authored title and never by the message, and carries no text
from the control it points at. `coach/placement.test.ts` proves the card never
covers the control, always sits inside the viewport and docks to the far edge
on a phone; `coach/CoachHud.test.tsx` proves what is on it at each step (Next
on every step, Back, Replay and Done, the meter, "your move", "not on screen").
`apps/pages/scripts/verify-tutorials.mjs` is the browser half: every tutorial,
walked in Chromium (see AGENTS.md).

`stylesheet-contract.test.ts` and `coach-stylesheet.test.ts` read the two
stylesheets as data and assert they cannot reach past this feature: every
`support.css` rule is anchored on the panel's own scope and every `coach.css`
rule on `.coach`, neither anchors on a shared control or a bare element, a
shared control is reached only from inside the panel, and the reduced-motion
block neutralises every animation each stylesheet starts — and every glide the
card makes — and moves nothing on a support transition.

`reflow.test.tsx` covers the structural half of a narrow viewport and is candid
in its own header about the other half: jsdom performs no layout, so no media
query is evaluated and nothing can overflow, and nothing there can show the
panel is legible at 320 CSS pixels or at 400% zoom. What it does prove is what
actually breaks — no control is dropped or hidden when the window narrows to a
phone, the way out and the way in stay outside the region that scrolls, and a
2,000-character unbroken answer leaves every control reachable.

`guide-motion-and-focus.test.tsx` covers the composition rather than the card:
a tutorial starts on the live page with the sheet closing itself behind it,
reduced motion stops the aperture gliding, the caret lands on Next and can leave
the card again — the tutorial guides, it does not trap — arrows step only while
the caret is in the card, and Escape leaves the tutorial and hands the caret
back (except from a text field, where it is the field's own way out).

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

**Native browser gate.** `pnpm --filter @opensesame/pages verify:webmcp`
uses Chrome's `WebMCP` DevTools Protocol domain against the built PWA.
The existing required Bundle budgets job runs it with the runner's Chrome
and experimental Web Platform features enabled. It fails if the native API
or protocol is absent, registration is empty, navigation does not change the
rendered tab, or session tools survive locking. It does not install a polyfill.
The mock suites remain useful for rejected promises and cleanup races; they
are no longer the only registration evidence.

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
source-graph test (`packages/app-core/src/tutorial/agents/ag-ui/bundle-hygiene.test.ts`)
proves the *imports* are dynamic and not that the bundler honoured them. In the
build measured here the entry chunk is `assets/index-*.js`. The AG-UI adapter
is a small separate chunk reached through a `__vite__mapDeps` dynamic import,
and the library closure that carries the AG-UI event vocabulary is a further
chunk the entry does not name at all. That build still shipped Driver.js as
its own chunk, a separate hints chunk and two stylesheets, none of them
statically imported by the entry. ADR 0163 has since removed Driver.js, along
with its `rendering/` adapter and `rendering-contract.test.ts`: the tutorial
card is a lazy React chunk loaded the first time a tutorial has a step to
draw, behind the same `lazy` boundary as the panel, and
`pnpm --filter @opensesame/pages verify:tutorials` walks it in a real browser.

**Residual gap.** That inspection is manual and one-off. Nothing in CI asserts
it, so a bundler configuration change could pull the AG-UI library or the
coach chunk into the boot chunk without failing a build or a test. A chunk-composition assertion is the
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
a payload class nobody tested. Folding these cases into `tests/redteam`
alongside the existing structural pact suite would put them under the same
sweep as the other agent surfaces, and that has not been done.

**The Playwright visual and e2e suites were not run.** `pnpm test:visual` and
`pnpm test:e2e` need a served build and a browser. No pixel baseline exists for
the support panel or for a highlighted control, so a visual regression in the
overlay would not be caught — and `tests/visual-contract` is where the
browser-driven half that `reflow.test.tsx` cannot cover would go: legibility at
320 CSS pixels, behaviour at 400% zoom, and whether the card actually lands
beside the control it names.

**No coverage or mutation figure is claimed for the new packages.**
`pnpm test:coverage` and `pnpm test:mutation` were not re-run, and none of
`guide-lang`, `guide-runtime` or `support-agent` is in the
`tools/mutation/stryker.config.json` mutate list. Per [`test-coverage.md`](test-coverage.md)
the per-package 50% lines floor applies to any measured package, so these will
be measured the next time that gate runs; the figures in that document were not
updated here because the gate was not run.

**No fuzz target exists for the GuideLang parser.** It is the obvious
candidate — a small, dependency-free, all-or-nothing parser sitting directly on
untrusted input — and `tests/fuzz/jazzer` is where a Jazzer.js target would go
(`support_payload` there covers `parseSupportTurn` and
`redactSupportQuestion`, not `parseGuide`).

**jsdom is not a browser.** It computes no layout, so geometry, focus-ring
rendering and whether a highlight is actually visible where the card claims
are all unproven. The inertness suite's value is that it drives hostile model
output through the real chain to the real card, not that it renders like Chrome.

**Accessibility is asserted by behaviour, not audited by a tool or a person.**
The suites cover naming, landmarks, labelling, focus containment and
restoration, tab order, Escape against the vault keymap, pointer-free operation
of every control, and the words each state announces. What is missing is an
automated rule sweep — there is no axe-style audit — and verification with a
real screen reader in a real browser: asserting a live region exists and
carries the right words is not the same as hearing the order and timing of what
is actually spoken as a highlight moves. Colour contrast of the overlay and the
card is also unmeasured.

**Offline behaviour is covered by construction, not by an offline test.** The
no-model path is exercised (`answers an authored topic with no model at all`),
but nothing runs the installed PWA with the network genuinely down.
