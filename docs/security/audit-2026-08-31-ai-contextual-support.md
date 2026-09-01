# Audit 2026-08-31 — AI-native contextual support

Status: design audit of a new subsystem; no vulnerability found, no code changed

## Nature of this entry

The rest of this series documents a specific vulnerability that was found and
fixed. This one does not. It is a pre-merge review of a subsystem that is new
in its entirety — the in-product support assistant and the adaptive tutorial
system of [ADR 0088](../adr/0088-ai-native-contextual-support.md) — carried out
by attacking the assembled feature rather than by reading it. Nothing was
repaired because nothing was found to repair. The entry exists so that what was
attacked, what held, what is enforced structurally rather than by convention,
and what remains true regardless are on the record at the point the feature
landed, instead of being reconstructed later from a diff.

The claim under test is unusual enough to restate. This design does not argue
that the model behaves; it argues that a model which does not behave cannot
express damage, because the language it writes has no production for damage.
That is a structural claim, so it is falsifiable by test, and the work below
is an attempt to falsify it.

## Scope

- `packages/guide-lang` — the grammar, the identifier validators, the budgets.
- `packages/guide-runtime` — the state machine and its ports.
- `packages/support-agent` — the port contract, the egress boundary, the turn
  splitter and bounded repair, the session and its transcript.
- `apps/pages/src/tutorial/**` — the registries, the page-context builder, the
  Driver.js adapter, the Prompt API and AG-UI adapters, the composition root.
- `apps/pages/src/webmcp/tools.ts` — the two guidance tools and the seam they
  reach the panel through.
- `packages/webmcp` — detection, the registrar, the agent fence.

The adversarial suite written for this review lives in
`apps/pages/src/tutorial/__tests__/adversarial/`. It deliberately does not
re-test any component against its own fakes; every case crosses at least one
module boundary, because the per-package suites are strong and the joins
between them were the least-observed part of the feature.

## Threats attacked, and what held

1. **Model-authored actuation.** A scripted agent returned
   `click "#reveal-secret"`, `navigate "javascript:alert(1)"`,
   `navigate "https://evil.example"`, `focus "#password"`, `focus "div>span"`,
   `eval`, `execute-tool "opensesame_shared_session_admit"`, an unbounded
   `wait`, and a four-hundred-instruction program, driven through the egress
   boundary, the turn splitter, the one permitted repair, the live page
   vocabulary and the runtime. In every case the recording renderer logged zero
   calls and the route controller zero navigations, with no deadline left
   armed. The refusals are unknown-directive parse failures rather than denied
   ones, and parsing is all-or-nothing, so no valid prefix ran either. A benign
   control case in the same file draws and navigates, so the assertions are not
   passing on a mis-wired harness.

2. **The error channel as an injection channel.** The bounded repair re-ask was
   checked to carry the compiler's codes and not the rejected program: neither
   `execute-tool` nor the tool name it named appears in the retry.

3. **Selectors and URLs reaching the DOM.** Over arbitrary strings
   (`fast-check`, 400 runs per position), no candidate became a target, a route
   or a predicate the compiler accepted, and `resolveGuideTargetElement` — the
   only edge in the application where an identifier becomes an element —
   returned `null` for every one. `guideRouteForPath` was likewise shown total
   onto the registered route set for arbitrary paths and arbitrary strings, so
   the route the page reports is always one the registry declares.

4. **Prompt injection through authored content.** ADR 0088 names the real
   vector: vault item names, folder names, connection labels and
   KDBX-imported entries are attacker-controlled text this application renders
   by design. A vault was populated with injection-shaped names, a folder name,
   an imported-entry name and a connection label, and the assembled page
   context was checked on every registered route, along with the system
   instruction built from it, the AG-UI outbound body, and the text of the
   overlay a walkthrough drew. No sentinel, item name or item id appeared in
   any of them. A companion assertion proves the vault really did hold that
   text, so the check is not vacuous.

5. **Secret disclosure.** The same fixture carried password, TOTP seed, card
   number and code, secret value, note body, hidden field value, private key,
   recovery code and bearer-token sentinels, using the sentinel pattern already
   established in `apps/pages/src/webmcp/tools.test.ts`. None reached the page
   context, the instruction string, the outbound body or a rendered popover. A
   vault record attached to a request is refused by `sanitizeSupportRequest`
   before anything is sent, on the denied key term rather than on inspection of
   the value.

6. **Vault lock under load.** Lock was fired at four awkward moments: with a
   model request in flight, with a `wait` armed and its deadline running, with
   a highlight standing after a `pause`, and with a persistent annotation on
   screen. In each case the transcript emptied, the provider session was
   destroyed, every overlay left the document and the deadline was disarmed. A
   provider that ignores its abort signal and answers *after* the lock — with a
   program that would otherwise have drawn — changed nothing, and a subsequent
   click on the control the torn-down guide had been waiting on did nothing.
   The subscription itself was exercised through `vaultStore.onLock`, so the
   lock the application actually listens to is the vault's own.

7. **Stale and superseded work.** An answer to support request N−1 arriving
   after N brings its walkthrough with it; the session discarded both, and the
   runtime drew only the current one. A trajectory compiled on `/vault` does
   not compile at all once the page is on `/connections`, and one compiled
   before the move fails closed with `TARGET_NOT_MOUNTED` rather than drawing.
   Starting a second walkthrough cancels the first as `superseded` and leaves
   one deadline set at zero.

8. **Registry integrity.** An unknown target, route, predicate or goal is
   refused at the validate stage with the code that names what was missing. A
   syntactically valid but unregistered route (`/admin/secrets`) is refused by
   the registry, by the compiler, and again by the runtime when the program is
   handed in as an AST — the path a parser regression, or any future caller
   that assembles a program itself, would take. A second element cannot take a
   target's binding from the element already on screen. A target that leaves
   the page mid-walkthrough stops the trajectory after exactly one render.

9. **Guidance is not actuation.** The full WebMCP catalog was registered
   against a stub browser with every `execute` replaced by a recorder; no
   export of `@opensesame/webmcp`, called with arguments it does not declare,
   fired one, and a tool listing came back as metadata holding no callable. A
   hostile AG-UI stream emitting `TOOL_CALL_*` events naming a real tool
   (`opensesame_open_reveal`) and an invented one reached nothing: the adapter
   implements only the assistant-text family, the answer carried no trace of
   the tool names, and the GuideLang the stream carried still faced the
   compiler and was rejected. The outbound body was separately checked to name
   no WebMCP tool at all, so a model has no catalog to name one from.
   `opensesame_guide_start` was swept with arbitrary strings and refused every
   id nobody in this repository authored, GuideLang text included.

10. **Markup from a model to the glass.** Payloads were driven from a raw
    completion through the fence splitter, the compiler, the runtime and the
    real Driver.js library, and asserted on the document: literal text in a
    focus popover, a hint popover and an annotation, with no `img`, `script`,
    `svg`, `iframe`, `style` or `a` node created anywhere. The popover is named
    from authored text, carries no `aria-labelledby` into a model string, and
    carries no text from the control it is pointing at.

## What is structural, and what is convention

Structural — holds whether or not the model, or a future caller, cooperates:

- The absent grammar productions. There is no AST node and no runtime argument
  that carries a selector, a script or a tool name.
- Two-stage identifier checking (syntax, then registry membership), performed
  by the compiler and again by the runtime against the live ports.
- The budgets, enforced in `guide-lang` and re-enforced in `guide-runtime`.
- The single `GuideTargetId` → element edge, and `navigate` taking a registry
  route id through an injected router port.
- One live guide: `maxConcurrentGuides` is 1 and `start` supersedes.
- `textContent` in the Driver adapter; the model's string never enters a step
  Driver renders as HTML.
- `sanitizeSupportRequest` rebuilding from primitives, with exact-key
  checking, a denied-key-term list, host-object-key detection and refusal of
  accessor properties — a request is refused, never trimmed into shape.
- The transcript living in a closure, with no storage or logging path (source
  oracles in `tutorial/ui/support-hygiene.test.ts`).
- `opensesame_guide_start` and `opensesame_help` accepting only enum members.

Convention, or enforced at the call site rather than by a type — named here
because a reader should not have to infer it:

- `PageContextInput.pageId` and `.route` are caller-supplied strings. The
  egress boundary bounds them to a non-empty identifier of at most 64
  characters; it does not require them to be registry members. The application
  passes the literal `"pages"` and the output of `guideRouteForPath`, which
  this audit proved total onto the route registry — so the property holds, by
  the call site rather than by the contract.
- The target catalog's descriptions are hand-authored prose. That they never
  interpolate a user-created value is enforced by a source-level assertion in
  `registry/catalog.test.ts`, not by a type, and it is a standing obligation on
  every UI change.
- `mountGuideTarget` accepts any catalog id from any module in the application;
  the registry has no notion of which component is entitled to bind a target.
  A later mount cannot take a binding away from an element already on screen,
  but resolution falls through to another registered candidate once the first
  stops being pointable. Only application code can reach this, so it is inside
  the trust boundary — but it is a convention, not an enforcement.
- The system instruction is not a control and is documented as such in
  `support-agent/src/instructions.ts`. `SUPPORT_POLICY_CLAUSES` is pinned by a
  characterization test so a clause cannot evaporate in a rewrite; that keeps
  the text honest, it does not make it a boundary.
- A remote AG-UI endpoint cannot be authenticated from the browser, by design.
  The deployment-side reverse proxy is the mechanism, and it is the operator's
  to build.

## Verification

```bash
env -u NODE_OPTIONS pnpm --filter @opensesame/pages test -- src/tutorial/__tests__
env -u NODE_OPTIONS pnpm --filter @opensesame/pages test
env -u NODE_OPTIONS pnpm --filter @opensesame/pages typecheck
env -u NODE_OPTIONS npx biome check apps/pages/src/tutorial/__tests__
env -u NODE_OPTIONS pnpm lint:anti-slop:files apps/pages/src/tutorial
```

The adversarial directory is 63 tests across 7 files, run eight times
consecutively to check for order- and timing-dependence. The whole
`@opensesame/pages` suite is 2,573 tests across 191 files and passes with the
suite added. `pnpm --filter @opensesame/pages typecheck`, Biome and the
anti-slop Oxlint pass over the new files.

Command-level evidence for the rest of the feature, including what each
per-package suite proves, is in
[`docs/validation/ai-contextual-support.md`](../validation/ai-contextual-support.md);
it is not restated here.

## What could not be tested

- **No live model, on-device or remote.** The Prompt API is reached through an
  injected fake and the AG-UI transport through an injected one. Nothing here
  confirms that a browser's `LanguageModel` behaves as `detect.ts` assumes, or
  that a real AG-UI server's stream decodes.
- **No model was evaluated for susceptibility to injection.** The suite drives
  a *scripted* hostile agent. It measures blast radius, not likelihood, and
  the design's argument is that the former is what matters — but the two are
  not the same claim and should not be read as one.
- **`@ag-ui/client` is never loaded.** That is the intended consequence of the
  dynamic import, and it means the real library's event decoding is
  unexercised by this audit.
- **jsdom has no layout.** "The highlight lands visibly on the right control"
  is unproven. `isMountedGuideTarget` walks the computed-style ancestor chain
  for `display: none` / `visibility: hidden` rather than measuring a box, so a
  control that is present and visible by cascade yet zero-box, off-screen or
  occluded still reads as pointable.
- **The hostile corpus is ours.** Ten program shapes and fast-check generators
  we wrote are not an adversary. A payload class nobody thought of is a payload
  class nobody tested, and there is no coverage-guided fuzz target for the
  GuideLang parser — which is the obvious candidate, being a small,
  dependency-free, all-or-nothing parser sitting directly on untrusted input.

## Residual risk

These are properties of the design, not unfinished work.

- **The attacker's best case is still real.** With total control of the model's
  output, an attacker can produce a guide that points at a control the
  application itself declared and says something misleading beside it — up to
  eight steps, five hundred characters each, one guide at a time. Misdirection
  inside the product's own chrome is bounded by this design, not eliminated by
  it. What the bound buys is that the person still performs every click, and no
  ceremony, reveal, approval or mutation happens on the model's behalf.
- **A configured remote transport means the question leaves the device.** The
  page context is registry-derived and value-blind, so what leaves is which
  controls exist and which are on screen. The question itself is prose a person
  typed, and `redactionWarning()` says plainly that nothing in the system can
  tell whether a secret is hidden inside a sentence.
- **The context is a coarse inference channel.** A support model learns
  boolean facts — the vault is unlocked, a connection exists, a plane is
  reachable — and which controls are mounted. That is deliberately the least
  informative thing that still answers a question about the screen, but it is
  not nothing.
- **Driver.js writes its popover slots with `innerHTML`.** The adapter's
  `textContent` rule is a reading of a pinned version. A release that renders
  the description differently would need the adapter revisited; the version is
  pinned and `rendering/driver-xss.test.ts` plus the chain suite here are the
  tripwire.
- **One more parser sits on an untrusted path.** ADR 0088 records this as a
  cost and answers it with no dependencies, no partial programs, and budgets
  enforced before structural work. It remains a cost.
