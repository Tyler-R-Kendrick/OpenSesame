# AI-native contextual support

How the in-product support assistant and the adaptive tutorial system are put
together. The decision and its argument are in
[ADR 0088](../adr/0088-ai-native-contextual-support.md); this document is the
map of what is where and why the pieces are separated the way they are. The
test inventory is
[`docs/validation/ai-contextual-support.md`](../validation/ai-contextual-support.md)
and the threat review is
[`docs/security/audit-2026-08-31-ai-contextual-support.md`](../security/audit-2026-08-31-ai-contextual-support.md).

## 1. The dual boundary

There are two halves and one line between them.

**The model reasons over semantics.** It sees named controls, named routes,
boolean state predicates, named goals and the capability list — all authored,
all checked in. It emits prose and, at most, a GuideLang program naming those
same identifiers.

**Deterministic code owns the DOM.** Nothing the model writes reaches an
element, a router or an HTML parser. A `GuideTargetId` becomes an
`HTMLElement` in exactly one function, from a registry the application built
out of React refs. A route is navigated only if it is a member of a declared
list. Text is written as `textContent`.

The line between them is a compiler. Model output is a string until
`compileGuide` has proved it is a well-formed program naming only identifiers
this build actually has; before that it is treated as what it is — untrusted
text of unknown origin — and after it, it is still re-checked by the runtime.

## 2. Packages, and which way the arrows point

```
@opensesame/guide-lang       — grammar, AST, ids, limits, parser, validator
        ▲            ▲                     (no dependencies)
        │            │
        │   @opensesame/support-agent — port contract, egress sanitizer,
        │            ▲                  system instructions, turn + session
        │            │                  (depends on guide-lang, os-domain)
        │            │
@opensesame/guide-runtime — ports, deterministic state machine, clock, fakes
        ▲                            (depends on guide-lang)
        │            │
        └────────────┴──── apps/pages/src/tutorial/  — registries, browser
                                adapters, Driver.js renderer, the panel UI
```

Every arrow points toward the pure packages. `guide-lang` has no dependency on
anything, which is what lets the parser be fuzzed and property-tested without a
DOM, a network or a model. `guide-runtime` depends on the language and on
nothing else — no DOM, no router, no timer of its own. `support-agent` depends
on the language because it compiles what a model returned, and on `os-domain`
for boundary helpers, and on no provider SDK at all: the Prompt API adapter and
the AG-UI adapter both live in `apps/pages`, behind `SupportAgentPort`.

The application is the only layer allowed to know about elements. That is not
tidiness; it is what makes the two halves of §1 testable independently.

## 3. The registries

`apps/pages/src/tutorial/registry/` is the application's self-description, and
it is the only channel by which the tutorial system learns anything about the
app.

`catalog.ts` holds `GUIDE_TARGETS`: every control a guide may point at, with an
id, authored prose, a role, the routes it can appear on, and the ADR 0065
capability it exercises. The prose is written by us and checked in. Nothing in
it may interpolate a vault item name, folder name, connection label or account
address, because the whole catalog is handed to a model as context.

`targets.ts` binds those declarations to live elements. `mountGuideTarget(id,
element)` is called from the `useGuideTarget` hook in `react.tsx`, so a target
exists exactly while the control it names is on screen — which is what lets a
guide wait for `appear` and `disappear` without anything polling the DOM.
Activation is observed passively in the capture phase; the listener reports and
never calls `preventDefault`, never synthesises an event, never activates
anything.

A target holds *candidates* rather than one element, because a responsive shell
renders the same destination twice: Connections is a rail row on a desktop and
a tab-bar link on a phone, and exactly one of them is visible at any width.
Binding to a single element would make every navigation guide fail closed on
whichever form factor lost the mount race. `resolveGuideTargetElement` is still
the single place a `GuideTargetId` becomes an `HTMLElement`; it walks the
candidates in mount order and returns the first that is actually pointable —
connected, and not hidden by `display: none` or `visibility: hidden` anywhere
up its ancestry. "Mounted" therefore means "can be pointed at", which is the
only definition a guide can act on.

`routes.ts` declares the destinations `navigate` may reach, all of them
non-mutating in-app views. `guideRouteForPath` maps a live pathname down to the
nearest declared section, so page context stays honest about deep routes
(`/vault/:itemId/edit`) without widening what `navigate` can name.

`state.ts` is the predicate registry and `predicates.ts` is the app's own set of
them — did the person reach this area, is that plane up, is the vault open. A
predicate answers "did something happen"; none of them answers "what did the
person type". That is why the whole set can be handed to a model. They must
also be safe to read at any moment, the vault locked included, because
`readGuidePredicate` is called from a wait loop that has no idea what the app
is doing. Waiting on one is edge-driven: screens call
`announceGuideStateChange` after changing something a predicate reports, and
nothing scans the DOM or spins a timer.

`goals.ts` is the deterministic half of the product knowledge: named goals,
authored help topics with authored answers, and checked-in GuideLang programs.
A browser with no model at all still gets contextual help, substring search
over it, and real walkthroughs. Authored programs go through the same
`compileGuide` pipeline as model output — no privileged path, so the path is
exercised either way.

`context.ts` is the privacy boundary in one function.
`buildSupportPageContext` composes from the registries above plus the ADR 0065
`CAPABILITIES` list, and reads nothing else. It has no access to `innerText`,
form values, vault records, notices or storage, so there is no path by which a
secret can arrive in the object that is about to be sent to a model.

It also checks the one input it is given. `route` arrives as a caller-supplied
string, and `knownRouteOrVault` reduces an unregistered one to `/vault` rather
than reporting to a model that the app is standing somewhere that does not
exist. The corrected route is then what scopes targets and goals, so a rejected
route cannot widen what the model is shown either. The live caller passes
`guideRouteForPath`, which is total onto the registry, so the check is
belt-and-braces today — but a boundary that is correct only by coincidence of
its single call site is not correct, it is lucky, and the next caller is where
that runs out.

## 4. From question to highlight

```
person types a question           apps/pages/src/tutorial/ui/
        │
        ▼
buildSupportPageContext           registry/context.ts
  ← catalog / routes / state / goals / CAPABILITIES   (never the DOM)
        │  SupportPageContext
        ▼
SupportSession.ask                support-agent/src/session.ts
  the transcript lives in this closure and nowhere else
        │
        ▼
sanitizeSupportRequest            support-agent/src/egress.ts
  rebuilt field by field; denied keys and host objects refused
        │  SupportRequest              ← the last code before any model
        ├──────────────────────────────┐
        ▼                              ▼
prompt-api agent (on device)    ag-ui agent (dynamic import, default
tutorial/agents/prompt-api/     off; prompts leave the device)
        │                       tutorial/agents/ag-ui/
        │                              │
        └──────────────┬───────────────┘
                       ▼
        SupportTurn { answer, guide, suggestedQuestions }
                       │            guide is still an untrusted string
                       ▼
             runSupportTurn                  support-agent/src/turn.ts
               prose survives a guide that never compiles;
               one bounded repair carries codes, never the payload
                       │
                       ▼
             compileGuide                    guide-lang/src/validate.ts
               parseGuide     syntax: not a selector, not a URL, budgets
               validateGuide  vocabulary: this build declares these ids
                       │  GuideProgram
                       ▼
             GuideRuntime.start              guide-runtime/src/runtime.ts
               re-checks every id; owns every deadline via GuideClock
                       │
      ┌────────────────┼──────────────────┬────────────────────┐
      ▼                ▼                  ▼                    ▼
GuideRenderer   GuideTargetResolver  GuideRouteController  GuideStateObserver
      │                │                  │                    │
rendering/        registry/           registry/            registry/
driver-renderer   targets.ts          routes.ts            state.ts
 Element only,    React-ref mounts    registered ids       boolean predicates
 textContent
      │
      ▼
Driver.js 1.8.0 (dynamic import) — overlay, stage, popover
      │
      ▼
GuideOutcome ──────────────────────────────────► the model replans
```

The loop closes at the bottom. A trajectory runs to its next observation
boundary — the person activated the control, the route changed, a predicate
flipped, the instructions ran out — and settles on a `GuideOutcome` carrying
semantic facts rather than a rendering log. That outcome is what the support
layer replans from, which is what makes the system adaptive instead of a linear
tour.

## 5. The compile pipeline

`parseGuide` (`guide-lang/src/parse.ts`) is a hand-written line-oriented parser
with no dependencies. It checks the byte, line and instruction budgets before
doing structural work, requires `guide/1` first and `goal` second, requires a
`timeout=` on every `wait`, refuses repeated and unknown named arguments,
refuses anything after `pause` or `end`, and refuses C0/C1 controls, bidi
overrides and zero-width characters in model-authored text. Strings are JSON
string literals, so escaping is JSON's rather than something invented here.

Parsing is all-or-nothing: a program with a valid prefix and a later error
yields no program. Diagnostics are a closed set of codes
(`guide-lang/src/errors.ts`) rendered as fixed sentences with a line and a
column. A diagnostic never echoes the offending payload, because a parse error
is derived from model-authored text and is shown to a person — echoing it would
reopen, in the error channel, the injection channel the grammar closes.

`validateGuide` then checks identifiers against the vocabulary the application
declares. Syntax proves a string cannot be a selector, a URL or a script; it
cannot prove `nav.connections` is a control this build has. Those are different
questions and both are asked.

`turn.ts` runs that pipeline over model output and enforces two rules. A failed
walkthrough never swallows a good answer — the prose survives even when the
attached guide is discarded whole. And repair is bounded to
`SUPPORT_LIMITS.maxGuideRepairAttempts` (one) and carries error *codes* back to
the model, never the payload that failed.

## 6. The runtime

`createGuideRuntime(ports)` (`guide-runtime/src/runtime.ts`) is a state machine
over `GuideRuntimePorts`. It re-validates every identifier and every budget
rather than trusting the compiler that produced the program, because a runtime
that trusted its parser would be one refactor away from executing something
unvalidated.

It owns every deadline. `GuideClock.after(ms, signal)` is injected, so the
production clock uses timers and tests drive `createTestClock()` — no guide
test sleeps. The wait ports (`observe` on targets, routes and predicates) never
resolve on a timer of their own; they settle on the observation or reject on
the abort signal, and the runtime decides what a timeout means.

One trajectory is live at a time. Starting a run supersedes the one in flight —
`GUIDE_LIMITS.maxConcurrentGuides` is 1 — and `cancel(reason)` takes `user`,
`lock`, `navigation` or `superseded`. Stale async work compares against the
monotonic `runId` on the snapshot, so a resolution arriving from a cancelled run
cannot advance a live one.

`GUIDE_RUNTIME_NOTES` is the closed set of notes an `observed` outcome may
carry. The note says why the trajectory stopped and is written by the runtime,
never by a model, so the support layer branches on it without parsing prose.

## 7. Rendering

`apps/pages/src/tutorial/rendering/driver-renderer.ts` implements
`GuideRenderer` over Driver.js 1.8.0, loaded through a dynamic import so it
stays out of the vault's initial bundle. Two rules define the adapter.

**A target becomes an `Element`, never a string.** Driver.js's
`DriveStep.element` accepts `string | Element | (() => Element)`; the string
form is its CSS-selector path. The adapter takes an injected `resolveElement`
— the registry's resolver — and passes elements, so the selector path is never
taken and there is no edge from an identifier to a query.

**Model prose is written as `textContent`.** Driver.js sets popover `title` and
`description` with `innerHTML`. The adapter therefore never puts a message in a
step at all: the popover is handed a fixed placeholder, and the real text is
written from Driver's `onPopoverRender` hook, which runs after the markup sink
and before the popover is measured. There is no path from a message to an HTML
parser.

`focus` uses Driver's overlay-and-popover path; `hint` uses its separate
`driver.js/hints` entry point, so a beacon can sit beside a control without
dimming the page; and `annotate` uses `annotation.ts`, an OpenSesame surface
with no library behind it, for the cases where even a beacon would be too much.
All three stylesheets — Driver's two and ours — are imported alongside the
library, on demand. The adapter's local types
(`GuideDriverStep`, `GuidePopoverNodes`, `GuideDriverFactory`) model only the
slice of Driver.js used here, and none of the library's own types cross the
module boundary — which is how the port stays replaceable.

## 8. The support agent and its providers

`SupportAgentPort` (`support-agent/src/contract.ts`) has three methods:
`availability()`, `run(request, options)` and `destroy()`. `SupportTurn` — what
a provider may return — carries an answer, an optional unparsed GuideLang
string, and suggested follow-up questions. There is deliberately no field
through which a provider can return a tool call, a URL, a selector or an
authority mutation.

`sanitizeSupportRequest` (`egress.ts`) is the last code that touches a request
before it reaches any model. It **rebuilds** its result field by field from
primitives rather than spreading, cloning or round-tripping through JSON,
because each of those forwards whatever it was handed — an element, a getter
that runs on read, a vault record — while only looking like a boundary.
Rebuilding means an unexpected key has nowhere to go. It additionally refuses
denied key terms (matched with case and separators stripped, so `private_key`,
`Private-Key` and `PRIVATEKEY` are one denial) and refuses objects carrying
host-object keys, which is how a live browser object is caught whatever its
prototype claims. A refusal raises `SupportEgressRefused`, distinct from the
rest of `SupportError` so a caller knows nothing left the device.

`instructions.ts` builds the system instruction. It is explicitly *not* the
security boundary — the grammar, the registries and the runtime are, and they
hold whether or not the model cooperates. The instruction exists so a
cooperating model produces something those boundaries accept, and so a person
gets an explained refusal rather than an arbitrary one.
`SUPPORT_POLICY_CLAUSES` is asserted verbatim by a characterization test so a
security clause cannot evaporate in a rewrite of the surrounding prose.

Two providers implement the port, both in `apps/pages`:

- **On device.** `tutorial/agents/prompt-api/` detects the browser's built-in
  `LanguageModel`, normalizes its availability to `unavailable` /
  `downloadable` / `downloading` / `available`, and mints a session with
  initial prompts. No vendor SDK, no network. `detect.ts` binds the platform
  methods and lets no raw platform value out of the module.
- **Remote.** `tutorial/agents/ag-ui/`, default off and dynamically imported,
  for a deployment that runs its own model. `transport.ts` is the only file
  that imports `@ag-ui/client`, and it does so inside the run path, so a
  browser that never configures an endpoint never loads the library or its
  dependency closure. AG-UI's own types stop at that file: everything above it
  sees a request in and untrusted JSON values out, re-read through guards.

  Two boundaries meet in that adapter and neither trusts the other. Outbound,
  `endpoint.ts` decides where a question may go at all: one deploy-config key
  (`supportAgentUrl`), https anywhere, http only on loopback or this page's own
  origin, and refusals for scheme-relative references, embedded credentials, a
  query, a fragment, and anything that is not a URL. Headers are a constant
  rather than a setting, because a browser cannot hold a credential for a
  third-party endpoint — a deployment that needs authentication puts the
  endpoint on its own origin behind a proxy that holds the secret server-side.
  The request is sanitized, rebuilt into an enumerable envelope, and
  structurally scanned before a transport is even constructed, so a refusal
  happens with nothing on the wire; the POST itself carries no ambient
  credentials and follows no redirect.

  Inbound, an AG-UI stream is a protocol for *driving* an application: tool
  calls, state snapshots, JSON-patch deltas, activity, subagents. This adapter
  implements exactly one of those event families — assistant text — and drops
  the rest. There is no branch in it that can reach a Host mutation, a WebMCP
  tool, a router or the DOM, so a server asking for one is not refused so much
  as unheard. The only influence a server has is prose and a GuideLang string,
  and that string meets the same parser and validator as every other guide.

`support-agent/src/fake.ts` is the third implementation of the port — scripted,
deterministic, and a real implementation rather than a mock, because there is
no module mocking anywhere in this repository. It is what every other package
tests against, and it can reach the awkward provider states on purpose: a model
that is not downloaded, a transport that dies mid-answer, output that is not a
program.

`support-agent/src/session.ts` holds the conversation. The transcript lives in
that closure and nowhere else: never `localStorage`, never IndexedDB, never a
log line, an analytics event or a telemetry span. The session's `generation`
counter is monotonic and a result carrying an older generation is discarded, so
an answer to a superseded question cannot land in the panel.

`apps/pages/src/tutorial/session.ts` is the composition root: it assembles the
registries, whichever agent this browser can reach, the runtime and the
renderer, and exposes a controller to the panel. Nothing above it knows any of
those exist, and nothing costly is imported at module scope — a closed panel
costs the boot bundle one button and a state machine, while the agent adapters,
the runtime, Driver.js and the capability registry all arrive on first open.
`tutorial/ui/` holds the panel's presentation.

## 9. Lifecycle

**Mount.** The registries are module-scope declarations, so targets, routes,
predicates and goals exist before any guide can run. Nothing about the tutorial
system depends on a model being present.

**Ask.** Page context is read fresh on every ask (`readContext` in
`SupportSessionDeps`), because the page the person is looking at moves between
questions.

**Run.** One guide, superseding, with every deadline owned by the runtime.

**Navigation.** A route change updates the composition root's notion of where
the person is (`setRoute`) rather than cancelling the guide, because a `wait
route` is very often satisfied by exactly that navigation. Targets unmount with
their screens, so a highlight cannot outlive the control it points at; a guide
whose next instruction names something that is no longer mounted fails closed
on `TARGET_NOT_MOUNTED`. `GuideCancelReason` carries a `navigation` value for a
caller that does want the harder behaviour; nothing in `apps/pages` uses it
today.

**Vault lock.** Lock is the interesting one, because it has to be synchronous
and total. `clearMountedGuideTargets()` drops every live binding and every
activation listener; the runtime is cancelled with reason `lock`;
`GuideRenderer.clear()` tears down every overlay, popover and hint;
`SupportSession.destroy()` drops the transcript and calls
`SupportAgentPort.destroy()`, which disposes the provider session. A
conversation about somebody's vault must not outlive the vault being open, and
a highlight must not survive pointing at a screen that is no longer authorized.

**Close.** Dismissing the panel cancels the guide with reason `user`. Unmounting
the provider runs the same teardown as a lock.

Escape deserves a note, because two subsystems claim it. The panel is not a
native `<dialog>` — the shared sheet layer traps focus rather than inerting the
page — and the vault keymap underneath owns every unmodified key, with Escape
bound to closing search. So the sheet's Escape handler has to close the sheet
*and* stop the keymap acting on the same keystroke; without that bail-out,
dismissing a help sheet would quietly reach into the vault behind it. The same
reasoning applies to every other vault key while the sheet is up.

## 10. The WebMCP surface

`packages/webmcp` probes `document.modelContext` first and the legacy
`navigator.modelContext` second, normalizing both to one `ModelContextApi`
whose methods are pre-bound to whichever object answered. Nothing above that
module branches on which one it was. Absence of the API means every
registration silently no-ops — WebMCP is progressive enhancement, never a
requirement for the page to work.

Support appears on that surface as two ceremony-open tools in the ADR 0065 §5
style. `opensesame_help` (capability `client.support`) opens in-product support
on an authored help topic, or on none at all; a topic nobody authored is
refused. `opensesame_guide_start` (capability `client.tutorial`) starts an
authored goal by id, and refuses both an unnamed goal and any GuideLang text —
an agent may ask for a walkthrough somebody wrote, it may not author one. Both
are session-scoped, both return only a fixed status and the authored id they
were given, and neither reads a transcript. The capability-registry entries are
what make that decision visible in the diff, and the registry-parity sweep in
`apps/pages/src/webmcp/registry-parity.test.ts` fails if the implemented
catalog and the registry-derived catalog disagree.

The reasoning for keeping guidance off the tool channel is in ADR 0088 §8: the
WebMCP catalog is governed and fenced, and putting support prose and authority
mutations on one channel at one trust level would leave no structural answer to
the first request for a guide that "just opens the approval dialog".

## 11. Where each check physically lives

| Check | File | Function |
|---|---|---|
| An identifier cannot be a selector, XPath or URL | `packages/guide-lang/src/ids.ts` | `isGuideTargetId`, `isGuideRouteId`, `isGuidePredicateId` |
| A route cannot be external, protocol-relative or traversing | `packages/guide-lang/src/ids.ts` | `isGuideRouteId` |
| Only ten directive names exist; anything else fails the parse | `packages/guide-lang/src/ast.ts` | `GUIDE_INSTRUCTION_NAMES`, `isGuideInstructionName` |
| Controls, bidi overrides and zero-width characters in model text | `packages/guide-lang/src/ast.ts` | `hasForbiddenTextCharacter` |
| Size, line, instruction and timeout budgets | `packages/guide-lang/src/ast.ts` | `GUIDE_LIMITS` |
| All-or-nothing parse; no valid prefix is ever executed | `packages/guide-lang/src/parse.ts` | `parseGuide` |
| Diagnostics never echo the payload | `packages/guide-lang/src/errors.ts` | `guideParseErrorMessage` |
| Identifiers must exist in this build | `packages/guide-lang/src/validate.ts` | `validateGuide`, `compileGuide` |
| Budgets and identifiers re-checked before the DOM | `packages/guide-runtime/src/runtime.ts` | `createGuideRuntime` |
| One live guide; every deadline owned by the runtime | `packages/guide-runtime/src/runtime.ts` | `start`, `cancel`, `GuideClock` |
| Nothing but registry data reaches a model | `apps/pages/src/tutorial/registry/context.ts` | `buildSupportPageContext` |
| The outbound payload is rebuilt, not forwarded | `packages/support-agent/src/egress.ts` | `sanitizeSupportRequest` |
| Denied key terms and host objects refused before egress | `packages/support-agent/src/egress.ts` | `SupportEgressRefused` |
| Bounded repair that never echoes model text | `packages/support-agent/src/turn.ts` | `runSupportTurn` |
| Security clauses cannot silently disappear | `packages/support-agent/src/instructions.ts` | `SUPPORT_POLICY_CLAUSES` |
| The only identifier-to-element edge | `apps/pages/src/tutorial/registry/targets.ts` | `resolveGuideTargetElement` |
| Model prose written as text, never markup | `apps/pages/src/tutorial/rendering/driver-renderer.ts` | `createDriverRenderer` |
| Transcript never persisted; dropped on lock | `packages/support-agent/src/session.ts` | `destroy` |
| Where a question may be sent, and that it carries no credential | `apps/pages/src/tutorial/agents/ag-ui/endpoint.ts` | `readAgUiEndpointUrl` |
| A server's tool calls and state patches are unheard, not refused | `apps/pages/src/tutorial/agents/ag-ui/ag-ui-agent.ts` | `createAgUiSupportAgent` |
| Agent payloads fenced before leaving a WebMCP handler | `packages/webmcp/src/fence.ts` | `fenceForAgent` |
| No secret-shaped tool names on any agent catalog | `packages/capability-registry/src/index.ts` | `assertsNoSecretNames` |

## 12. What is deliberately absent

There is no `click`, `type`, `fill`, `submit` or `eval` directive, and no
runtime method that would receive one. There is no code path from a
model-authored string to `querySelector`, `innerHTML` or
`dangerouslySetInnerHTML`. There is no reader of `innerText`, form values,
vault records or storage anywhere in the tutorial system. There is no way for
guidance to invoke a WebMCP tool or any authority mutation. There is no
persistence of a support conversation. And there is no second guide: the limit
is one, in the language's own budgets, so two overlays fighting over the screen
is not a reachable state.
