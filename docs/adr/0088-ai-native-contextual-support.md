# ADR 0088 — Contextual support that guides, in a language that cannot act

- Status: Accepted
- Date: 2026-08-31
- Supplements: [ADR 0005](0005-authority-handle-connectionref.md) (agents hold
  handles, never material), [ADR 0017](0017-host-client-product-topology.md)
  (client plane owns the PWA), [ADR 0065](0065-agent-surface-parity.md)
  (capability registry, WebMCP lifecycle, ceremonies stay human),
  [ADR 0080](0080-security-event-hooks.md) (a detector converts into a shared
  envelope rather than growing a private path)

## Context

People ask "how do I…" of the interface in front of them, not of a
documentation site in another tab. That is truer here than in most products:
`apps/pages` is an installable, offline PWA holding an end-to-end-encrypted
vault, so at the moment somebody is most confused there may be no network to
go and read anything on. The product's own help was a set of screens that
either explain themselves or do not.

A model in the product can answer that question well. It knows the vocabulary,
it can be told what is on screen, and — this is the part that makes it worth
building rather than shipping a search box — it can point at the control. The
difference between "Connections is in the left rail" and a highlight around
the actual rail entry, on the actual screen, in the state the person is
actually in, is most of the value.

The difficulty is what "point at the control" turns into if it is implemented
the obvious way. An agent that can produce a selector and have the page act on
it is an agent that can produce `#reveal-secret` and have the page act on that.
An agent that reads the DOM for context is an agent whose context window now
contains whatever the vault was rendering. And the prompt that steers such an
agent is not written only by the person at the keyboard: this application
renders connection labels, shared item titles, folder names and entries
imported from somebody else's KDBX file. Text an attacker controls reaches the
screen by design. If that text can reach the model, and the model can reach the
DOM, the whole chain from "somebody named a vault item cleverly" to "the vault
revealed a credential" is one system away from closing.

There is a second temptation worth naming, because it is the efficient one.
The page already has an actuation layer: WebMCP, with a governed tool catalog,
a fence on every payload, and session tools that exist only between unlock and
lock (ADR 0065 §7). "Let the support model call the tools" is a week of work
and a good demo. It is also how the ADR 0065 boundaries acquire a second path
around them and how the ADR 0005 ConnectionRef discipline acquires an exception
for the helpful case.

## Decision

### 1. GuideLang: a tutorial language that is deliberately under-powered

`packages/guide-lang` defines a versioned, line-oriented language whose entire
grammar is ten directives, one of which takes three subjects:

```
guide/1
goal "<goal-id>"
say "<text>"
focus "<target-id>" "<text>" [side=top|right|bottom|left]
hint "<target-id>" "<text>" [side=top|right|bottom|left]
annotate "<target-id>" "<text>" [side=top|right|bottom|left]
scroll "<target-id>"
navigate "<route-id>"
wait target "<target-id>" event=activate|appear|disappear timeout=<ms>
wait route "<route-id>" timeout=<ms>
wait state "<predicate-id>" is=true|false timeout=<ms>
success "<text>"
pause
end
```

A guide may *show* a person where something is and *wait* for them to do it.
There is no `click`, no `type`, no `fill`, no `submit`, no `eval`, no
`selector`, no `fetch`, no `execute-tool`, and no escape hatch — those are not
denied directives, they are unknown ones, and an unknown directive fails the
parse.

Parsing is all-or-nothing. A program with eight valid lines and a ninth the
parser cannot read yields no program at all, because executing a valid prefix
of an invalid program is how a partially-understood instruction becomes a
partially-executed one. `GUIDE_LIMITS` caps a program at eight instructions,
five hundred characters of model-authored text per directive, 8 KiB, thirty-two
lines, and timeouts in [250 ms, 60 s]; every `wait` must carry one, so an
unbounded wait cannot be written.

Diagnostics are fixed sentences chosen from a closed list of codes with a line
and a column. A parse error is derived from model-authored text and is shown to
a person, so echoing the offending payload back would reopen, in the error
channel, exactly the injection channel the grammar closes.

### 2. The missing expressive power *is* the security property

This is the load-bearing argument, and it is worth stating without hedging.

A system built the usual way says: the model has an action API, and we instruct
it not to misuse it, we validate its arguments, and we review its output. Every
one of those is a behavioural control. They hold while the model behaves. The
literature on prompt injection is a long record of models not behaving, and the
mitigations are all probabilistic, which is a fine property for a spam filter
and a poor one for a credential store.

A prompt-injected model here cannot ask for `click("#reveal-secret")` because
there is no way to say it. Not "we would reject it" — there is no production in
the grammar that derives it, no field on the AST that carries it, and no
argument on the runtime that would receive it. The failure is structural. The
attacker's best case, with total control of the model's output, is a guide that
points at a control the application already declared and says something
misleading next to it, bounded to eight steps, five hundred characters, one
guide at a time, with the person still doing every click themselves.

That is a much smaller worst case than "the model behaved", and unlike "the
model behaved" it does not degrade when a new model, a new prompt, or a new
jailbreak arrives.

The corollary is a rule about future work: **widening GuideLang is an ADR, not
a feature.** A `click` directive would move this system from the first category
to the second in one commit, and it would do so for a good-sounding reason.

### 3. A semantic target registry, not selectors and not DOM scraping

The model names controls the way a person does — `nav.connections`,
`shell.lock` — and `apps/pages/src/tutorial/registry/` is the only thing that
knows what those names point at. Identifiers are dotted lower-case words by
syntax (`isGuideTargetId`), which excludes `#`, `.`, `>`, `[`, `:`, `/` and
whitespace, so no CSS selector, XPath expression or URL is even well-formed;
and membership in the live catalog is checked separately, so an id this build
does not have fails closed instead of becoming a lookup miss at run time.

Bindings come from React refs (`useGuideTarget`), not from selectors, which
means a visual rebuild of the navigation cannot silently invalidate a guide —
the failure mode every selector-targeted onboarding platform has, where a CSS
refactor breaks live guides and a customer finds out first.

Model context is assembled the same way. `buildSupportPageContext` composes
from authored registries — target descriptions, route titles, boolean state
predicates, the ADR 0065 capability list, named goals — and reads nothing from
the document. It cannot see `innerText`, form values, vault records, notices or
storage, so there is no path by which a secret arrives in a place from which it
could then leak. The descriptions are checked-in prose written by us; nothing
in the catalog may interpolate a vault item name, folder name, connection label
or account address, because the whole catalog is handed to a model.

### 4. Two stages, because syntax and existence are different questions

`parseGuide` proves a string is not a selector, a URL or a script.
`validateGuide` proves the identifiers name things this application actually
declares. Neither subsumes the other, and the runtime re-checks membership
through its ports before anything reaches the DOM, because a runtime that
trusted its parser would be one refactor away from executing an unvalidated
program.

The budgets are likewise enforced twice — in `@opensesame/guide-lang` and again
in the runtime. Duplicated enforcement across a boundary is not redundancy when
one side is reachable from untrusted input.

The budgets on the *context* side are enforced twice as well, and deliberately
fail differently at each site. `apps/pages/src/tutorial/registry/context.ts`
assembles lists that are authored in this repository, so a list outgrowing its
budget is our mistake and a silent `slice` would hide it perfectly — the model
would simply stop being told about whatever fell off the end, with no test red
and nothing logged. The ADR 0065 capability list is the live example: it grows
on other people's merges rather than on this feature's, and it sits close
enough to its ceiling to cross it without anyone deciding to. So a development
or test build throws there, the way a target declared twice already does, while
a production build still trims rather than breaking somebody's session.

`@opensesame/support-agent`'s egress sanitizer trims the same lists silently,
and must keep doing so. That boundary exists to bound whatever it is handed;
throwing there would convert oversized input into a crash, which is the failure
mode a sanitizer is supposed to remove.

### 5. Driver.js as the rendering primitive, behind a port

`driver.js@1.8.0`, MIT, published with no runtime dependencies at all. In a
vault origin, every transitive package is code with the vault UI's reach, so a
zero-dependency renderer beat a richer one. It sits behind
`GuideRenderer` in `packages/guide-runtime/src/ports.ts`; tests drive a
recording fake, and replacing the library is a change to one adapter.

Two rules govern the adapter, and both came out of reading the library rather
than its documentation:

- **A target becomes an `Element`, never a string.** `DriveStep.element`
  accepts `string | Element | (() => Element)`; the string form is Driver.js's
  CSS-selector path and is the exact affordance a model-authored selector would
  flow into. We pass elements resolved by the registry, so that path is never
  taken.
- **Model-authored text is written as `textContent`.** Driver.js sets popover
  `title` and `description` with `innerHTML` — visible in its shipped bundle as
  `r.title.innerHTML=` and `r.description.innerHTML=`. That is a sensible
  default for a library whose callers write their own copy and a hostile one
  for a relay of model output. The adapter populates the popover's element
  handles itself. The parser separately rejects C0/C1 controls, bidi overrides
  and zero-width characters, so a transcript a reviewer reads renders as what
  will actually be shown.

### 6. The browser's on-device model is the first-party option

The Prompt API is the only provider for which the honest answer to "where does
my question go?" is "nowhere". It is therefore the default, and the availability
ladder it reports — unavailable, downloadable, downloading with progress,
ready — is carried through `SupportAgentAvailability` rather than collapsed to
a boolean, because a UI that says "unavailable" when the truth is "click to
download" is a worse product than no assistant at all.

Acquiring the model needs a user gesture and a substantial download, so it is a
ceremony rather than something that happens on mount. A session holds context
and is disposed through `SupportAgentPort.destroy()`, which vault lock calls:
a conversation about somebody's vault must not outlive the vault being open.

### 7. AG-UI as an optional remote transport, lazily loaded, behind the port

A deployment that runs a capable model on its own infrastructure should be able
to point the support surface at it, and adopting a protocol beats inventing a
request shape nobody else implements. `@ag-ui/client@0.0.59` (MIT) is that
protocol.

It is not the default and it is not statically imported. Its published
dependencies are `zod`, `rxjs`, `uuid`, `fast-json-patch`, `untruncate-json`,
`compare-versions` and the sibling `@ag-ui/core`/`@ag-ui/proto`/`@ag-ui/encoder`
packages carrying protobuf encoding — a large closure for an offline-first PWA
— and `0.0.59` is on an unstable `0.0.x` line where a patch bump may change
anything. So it is imported dynamically, meaning a browser that never
configures an endpoint never loads a byte of it, and it lives behind
`SupportAgentPort`, meaning the instability is contained to one adapter.

Turning it on means prompts leave the device. That is a real change to the
product's privacy posture, it is the operator's decision to make, and it is
recorded in the consequences below rather than smoothed over.

### 8. WebMCP opens support; it never drives it

`packages/webmcp` tracks the current `document.modelContext` placement and
keeps the legacy `navigator.modelContext` location working. Both exist in the
wild, the proposal is still moving, and a page bound to only one of them is a
browser release away from silently having no tools.

Guidance and actuation stay separate surfaces even though WebMCP is right
there. The WebMCP catalog is governed: each tool is a capability-registry entry
that is mapped or ADR-excluded, and every payload crosses the agent fence. If
guidance flowed through the same catalog, support prose and authority mutations
would arrive on one channel at one trust level, and the first request to have a
guide "just open the approval dialog" would have no structural answer. Two
channels with different powers is a boundary; one channel with a policy is a
promise. So the support agent's reply type (`SupportTurn`) has three fields a
model fills — prose, suggested follow-up questions, and an unparsed GuideLang
string — and no field through which a tool call, a URL or an authority mutation
can be expressed.

What WebMCP does gain is `opensesame_help`, which opens support on an authored
topic, and `opensesame_guide_start`, which starts an authored goal by id. Both
are session-scoped, both return a fixed status plus the authored id they were
given, and `opensesame_guide_start` refuses an unnamed goal and refuses
GuideLang text outright — an agent may ask for a walkthrough somebody wrote, it
may not author one. That is the ceremony-open style of ADR 0065 §5 applied to
guidance.

### 9. Short adaptive trajectories, not tours

A guide runs to its next observation boundary and stops. `maxInstructions` is
eight for that reason: the model plans as far as the next thing it can actually
observe — the person activated the control, the route changed, a predicate
flipped — and then replans from what happened. `GuideOutcome` carries semantic
facts (completed, observed at a route with a note, paused, cancelled with a
reason, failed with a code) rather than a rendering log, because that is what a
model replans from.

This is what makes the system adaptive rather than a linear tour that breaks
the moment somebody clicks somewhere unexpected. It also bounds the blast
radius of a bad plan to eight steps.

### 10. Authority is guidance-only, and knowledge lives in the app

The runtime observes; it never acts. Target activation is watched passively in
the capture phase and the listener never calls `preventDefault`, never
synthesises an event and never activates anything. `navigate` reaches
non-mutating in-app views by registered route id only. Nothing in the system
can enter a ceremony, submit a form, unlock, reveal or approve.

And the product knowledge is stored in typed data —
`apps/pages/src/tutorial/registry/goals.ts` holds named goals, authored help
topics and checked-in GuideLang programs — not only inside a prompt. A browser
with no on-device model and no configured endpoint still gets contextual help,
search and real walkthroughs. Authored guides are parsed and validated by the
identical pipeline model output goes through: an authored guide gets no
privileged path, because a path that only executes when the model is missing is
a path that is never exercised.

## What was rejected, and why

- **LLM-authored CSS selectors.** The direct route to "point at the control",
  and the one that makes `#reveal-secret` expressible. Rejected as the primary
  architecture because it converts every prompt-injection into a DOM
  capability, and because — as the onboarding-platform prior art shows —
  selector-targeted guidance rots silently under any visual refactor.

- **DOM scraping for model context.** Convenient, and the reason most in-product
  assistants know what is on screen. In this application the DOM is the vault's
  rendering, so scraping it puts credentials in the model's context window and,
  on a remote transport, on the wire. Context is assembled from authored
  registries instead.

- **Arbitrary browser automation.** A general driver (click, type, navigate)
  would let the assistant do the task rather than teach it. It also makes the
  assistant a confused deputy with the person's full session authority, which
  is the exact thing ADR 0005 exists to prevent for agents at the API boundary;
  granting it in the browser instead would be an odd place to make an exception.

- **CopilotKit as a mandatory dependency.** `useCopilotAction` is the model
  actuating the application, with safety supplied by which actions somebody
  chose to register; `useCopilotReadable` makes exposing application state a
  one-line convenience on a page where most state is somebody's credentials.
  Both are the right ergonomics for a product whose worst case is an
  embarrassing action, and the wrong ones here.

- **A2UI as the tutorial state machine.** An agent-driven UI protocol grows
  toward describing more interface, which is the correct direction for what it
  is. A tutorial language in a credential store has to grow toward being *more*
  constrained, so adopting one would mean permanently policing an accepted
  subset — behavioural enforcement again, one layer down.

- **OpenUI Lang as a runtime dependency.** We did not want a UI-description
  language at all. GuideLang describes a trajectory over semantic identifiers
  and renders nothing of its own. Taking a general description language would
  mean accepting a much larger surface from an untrusted producer, and putting
  a third-party parser between a model and the vault's DOM.

- **Fixed linear tours as the only model.** They break at the first unexpected
  click and cannot answer a question. They remain available — an authored goal
  is a checked-in program — but as one shape a trajectory can take, not as the
  system.

- **Cloud-only support.** The product is an offline-capable vault. A help system
  that requires a network is missing at the moment it is most needed, and one
  that ships questions about a vault to a third party by default is not a help
  system we would want to explain.

- **Model-controlled authority mutations.** Never considered seriously, recorded
  so it is a decision. Every consequential act stays a human ceremony
  (ADR 0065 §5). The assistant's job is to get the person to the right screen
  knowing what they are about to do.

## Consequences

- **The target catalog is hand-authored, and stays that way.** Every control a
  guide can point at is a checked-in entry with prose written by us. Nobody
  generates it, and a control that nobody adds is a control the assistant
  cannot mention. That is the price of the property that the model's vocabulary
  contains nothing a user typed, and it is a maintenance obligation on every
  UI change, not a one-time cost.

- **Product knowledge is stored twice.** Once in the help graph and the authored
  guides, once inside whatever the model reasons with. They can disagree. **The
  help graph is the source of truth**; when the two conflict, the graph is what
  gets corrected and the model is what gets re-grounded. A single store would be
  simpler and would mean either no offline help or no model.

- **The on-device model is desktop-only today.** Most mobile users will never
  see the conversational surface. This is why the deterministic path is the
  product rather than a fallback: authored topics, search over them and real
  walkthroughs all work with no model at all.

- **A configured remote transport means prompts leave the device.** The
  question, the page context and the conversation go to whatever endpoint an
  operator pointed at. The context is registry-derived and value-blind, so what
  leaves is "which controls exist on this screen and which are mounted" — but
  it leaves. Default off, dynamically imported, and the operator's decision.

- **GuideLang v1 is frozen in the same sense the lifecycle event names are.**
  Additive changes are possible; a directive that acts is not, without an ADR
  that argues against §2. `guide/1` is in the wire format precisely so a v2 can
  exist without a v1 program becoming ambiguous.

- **One more parser sits on an untrusted path.** That is a real cost and it is
  answered by the parser having no dependencies, refusing partial programs,
  enforcing byte/line/instruction budgets before doing structural work, and
  emitting fixed diagnostics that never echo input.

- **Driver.js is a pinned, single-maintainer dependency**, and its popover
  writes HTML by default. Both are absorbed by the adapter boundary rather than
  by trusting the library: the port keeps the replacement cost to one file, and
  the `textContent` rule means an upstream change to popover rendering cannot
  turn model prose into markup.

- **Support is a capability-registry entry like anything else** (ADR 0065), so
  the WebMCP and MCP story for it is visible in the diff rather than implied.
  `client.support` and `client.tutorial` are agent-reachable as ceremony-open
  tools on WebMCP; driving a guide is not a tool at all. Both are **excluded
  from the headless MCP servers**, and the exclusion names why: guidance opens
  UI in a person's own unlocked tab and points at controls there, so a headless
  server has neither a page to guide nor a person watching, and the walkthrough
  is authored in-repo rather than accepted from a caller — there is nothing for
  a headless surface to carry.

- **A remote endpoint cannot be authenticated from the browser, and we do not
  pretend otherwise.** There is no header map and no token field in the AG-UI
  configuration, because a credential checked into a deploy is readable by
  anyone who can read the deploy and one held in storage is readable by any
  script on the origin. A deployment that needs authentication puts the
  endpoint on its own origin behind a proxy that holds the secret server-side,
  or runs it unauthenticated on loopback. That is a real constraint on who can
  use the remote path, and it is the right one: the alternative is a
  credential field that looks like security.

- **A guide is torn down when the vault locks**, along with the provider session
  and the transcript, and only one guide is ever live. `maxConcurrentGuides` is
  1 in the language's own limits, so "two overlays fighting over the screen" is
  not a state the system can reach.
