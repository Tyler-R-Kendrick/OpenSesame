# AI-native product tutorials — ecosystem assessment

Research input for [ADR 0087](../adr/0087-ai-native-contextual-support.md).
This document records what the existing tools in this space actually do, what
each one would have given us, and why it was or was not adopted. It is
research, not a decision record: where this document and ADR 0087 disagree,
the ADR wins.

The question under study: a person using the authority vault
(`apps/pages`) asks "how do I add a connection?" of the interface, not of a
documentation site. Answering that well needs a model that understands the
product, and a way to point at the actual controls on the actual screen. The
constraint is that this particular application is a vault. An in-product agent
that can drive the DOM is an agent that can be talked into revealing a secret,
and the person doing the talking does not have to be the person at the
keyboard — a connection label, a shared item, or a page the vault renders from
somebody else's data is enough of a channel.

So the survey below asks two questions of every candidate, in this order:

1. What can a compromised model make it do?
2. Only then: how good is the guidance it produces?

Most of this ecosystem was designed with only the second question in mind,
which is not a criticism of the tools — onboarding a SaaS dashboard has a
different threat model from operating a credential store. It is a reason the
answer here is a composition rather than an adoption.

## 1. Accuracy of the claims below

Version and licence claims are lockfile-verified for the two packages this
work actually installs — `driver.js@1.8.0` and `@ag-ui/client@0.0.59` — by
reading their published `package.json` from `node_modules`. Everything else in
this document was assessed from public documentation and from the shape of the
problem, and is **not** lockfile-verified here, because we did not vendor
those projects. Where a fact would matter to a future decision and we are not
certain of it, it is marked as needing verification rather than asserted.
Nothing below should be quoted as a licence review.

## 2. Tour renderers

This is the mature end of the ecosystem: libraries that put a hole in an
overlay, position a popover next to an element, and step through a list. All
four of the serious candidates can do that competently. They differ in what
they drag in with them and in how much of the page they insist on owning.

### Driver.js — chosen

`driver.js@1.8.0`, MIT, published with **no `dependencies` key at all**: the
runtime closure is the library and two optional stylesheets
(`dist/driver.css`, `dist/hints.css`, and a separate `./hints` entry point).
For a PWA that is installed, runs offline, and holds a vault, a zero-dependency
rendering primitive is worth more than a richer feature set — every transitive
package in that bundle is code executing in the vault's origin.

What it gives us, from its published types:

- `driver(config)` returns an imperative handle with `highlight(step)`,
  `drive()`, `refresh()`, `destroy()`, and `isActive()`. We use the
  single-step `highlight` path rather than its tour engine, because our step
  sequencing lives in `@opensesame/guide-runtime` where it can be tested
  without a browser.
- `DriveStep.element` accepts `string | Element | (() => Element)`. **We only
  ever pass an `Element`.** The string form is the CSS-selector path, and it
  is exactly the affordance a model-authored selector would flow into; not
  using it is what makes the semantic target registry the only way a target
  becomes an element.
- `disableActiveInteraction`, `allowClose`, `overlayClickBehavior`,
  `smoothScroll`, `stagePadding`, and side/alignment on the popover cover the
  presentation decisions we would otherwise have written ourselves.
- `onPopoverRender(popoverDom, opts)` hands back real element handles
  (`title`, `description`, `footer`, the buttons).

That last hook is load-bearing for a reason that is not obvious from the
README. **Driver.js writes `popover.title` and `popover.description` into the
DOM with `innerHTML`** — verified by reading `dist/driver.js.mjs`, which
contains `r.title.innerHTML=` and `r.description.innerHTML=` on the render
path. That is a reasonable default for a library whose callers write their own
copy. It is not a reasonable default for a library whose caller is relaying a
sentence a language model produced, possibly under the influence of text an
attacker controlled. So model-authored prose is never handed to Driver.js as
`description`; the browser adapter sets the text itself, as `textContent`, on
the element handle the render hook returns. This is the single most important
implementation detail this survey produced, and it would have applied to any
library in this section — most of them accept HTML in a popover.

Its cost, stated plainly: Driver.js is a single-maintainer project that has
moved repository owners (`package.json` now points at
`github.com/nilbuild/driver.js`), and we are pinned to an exact version with
no upgrade automation. Against that, the abstraction is one file wide — the
renderer sits behind the `GuideRenderer` port — so replacing it is a
contained change rather than a migration.

### Shepherd.js — not chosen

Framework-agnostic, mature, well documented, with framework wrappers and a
richer built-in tour model than Driver.js: attachment strategies, modal
overlays, a step queue with its own event lifecycle. It positions with a
floating-element library rather than hand-rolled maths, which is genuinely
better geometry than a small library will manage.

It was not chosen for two reasons. First, the runtime closure is larger and
brings a positioning dependency, which is the thing we are trying not to add
to a vault origin. Second, and more decisive, its value is concentrated in the
part we deliberately do not use: its tour state machine. Our sequencing has to
be a testable state machine over semantic identifiers with injected clocks,
because that is where the timeout budgets and the supersede-and-cancel rules
live. Adopting Shepherd would mean either duplicating that logic or
surrendering it to a library, and surrendering it means the security budget
lives somewhere we cannot exhaustively test without a DOM. Licence and current
version were not verified here; they were not the deciding factor.

### React Joyride — not chosen

The most idiomatic option for a React application, and `apps/pages` is a React
application. Steps are declared as data, the tour is a component, and the
integration cost is near zero for the common case.

It was not chosen because the coupling runs the wrong way. Joyride wants the
tour to be part of the React tree, which puts the guide's lifecycle under
React's rendering and reconciliation rather than under the runtime that owns
the abort signals. Our guide has to survive route changes, has to be torn down
synchronously when the vault locks, and has to be cancellable from outside any
component — a lock is not a re-render. A renderer behind a port with an
imperative `clear()` matches that; a component tree does not. The second
reason is narrower: tying the rendering primitive to React would make the same
guidance impossible to reuse from `apps/pwa` or a non-React surface later,
and the target registry is deliberately framework-neutral for that reason.

### Intro.js — not chosen

Feature-rich and long-established, with the most complete out-of-the-box
onboarding feature set of the four (tours, hints, progress, keyboard
navigation).

The blocker is licensing rather than engineering. Intro.js is published under
a copyleft/commercial dual model — AGPL-style terms for open-source use plus a
paid licence for commercial use, as we understand it. **This must be verified
against the current licence text before anyone reconsiders it**, and it is
recorded here as the reason it was not evaluated further rather than as a
finding. A private product cannot take an AGPL runtime dependency casually,
and we are not going to buy a licence for a popover.

## 3. Product-adoption platforms as prior art

Pendo and Chameleon are the commercial incumbents for exactly the user-visible
outcome this work produces: contextual in-app guidance, tooltips, walkthroughs
and checklists, authored by a product team without shipping code. Both are
worth studying and neither is adoptable here.

**Pendo** installs a third-party script into the application, records product
usage to build segments, and lets a designer target guides at elements picked
in a visual editor. **Chameleon** is the same category with a stronger
emphasis on the authoring experience for tours, tooltips and surveys.

Two things rule them out, and only the first is about privacy.

The obvious one: both are hosted services whose model is a script tag in your
origin plus usage telemetry leaving the browser. `apps/pages` is an installable
offline PWA that holds an end-to-end-encrypted vault. A third-party script with
DOM access in that origin has, by construction, the same reach as the vault UI
itself, and the whole point of the deployment is that nothing about vault
contents leaves the device. There is no configuration of a hosted analytics
suite that makes that acceptable.

The less obvious one is the transferable lesson. Both platforms target guides
using **selectors captured in a visual editor**, which is why every team that
has used one has the same complaint: a CSS refactor silently breaks live
guides, and nobody finds out until a customer does, because the guide fails by
pointing at nothing rather than by failing a build. That failure mode is the
strongest argument for the semantic target registry. When a guide names
`nav.connections` and the registry binds that name from a React ref, a visual
rebuild of the navigation cannot invalidate the guide, and *deleting* the
control fails a test that sweeps the catalog instead of failing in production.

That lesson is the reason the registry exists, so the prior art earned its
place in the design even though the products did not.

## 4. Agent-to-application protocols

This is the young end of the ecosystem, where the specifications are moving
faster than any of them is stable.

### WebMCP (`modelContext`) — already ours, and kept separate

The browser-side proposal for a page to publish tools to a model agent: the
page registers named tools with JSON Schema inputs, and an agent that is
present in the browser can call them. This repository already implements it —
`packages/webmcp` wraps the API behind feature detection so it silently no-ops
where unsupported, and `apps/pages` registers boot tools at mount and session
tools only between unlock and lock (ADR 0065 §7). The API surface is still
in motion; the package tracks the current `document.modelContext` placement
and keeps the older `navigator.modelContext` location working, because both
exist in the wild and a page that binds to one of them is one Chrome release
away from silently having no tools at all.

The interesting question was not whether to use WebMCP — we already do — but
whether the tutorial system should ride on it. It could: the page already has
an actuation layer with a fence in front of it, and "let the support model
call the tools" is the shortest path to something demonstrable.

It is the wrong path, for a reason that outlives this feature. The WebMCP
catalog is governed: every tool is a capability-registry entry, mapped or
excluded with an ADR citation, and every payload crosses `fenceForAgent`
before it leaves the handler. Guidance flowing through that same catalog would
mean support prose and authority mutations arriving on one channel with one
trust level, and the first time someone wanted a guide to "just open the
approval dialog for them" there would be no structural reason to say no. Two
channels with different powers is a boundary; one channel with a policy is a
promise. So the support agent has its own contract
(`packages/support-agent/src/contract.ts`) whose reply type has no field
capable of carrying a tool call, and the WebMCP catalog gains only two
ceremony-open tools: one that opens support on an authored topic, and one that
starts an authored walkthrough by name and refuses GuideLang text outright. An
agent may ask for a guide somebody wrote; it cannot write one, and it cannot
drive one.

### AG-UI — adopted, but lazily and behind a port

`@ag-ui/client@0.0.59`, MIT. An event-stream protocol between an agent backend
and a front end: typed events for message start/content/end, tool calls, state
snapshots and state deltas, with client-side reassembly. It is the right
abstraction for the case we do want to support — a deployment that runs a
capable model on its own infrastructure and wants the vault's support surface
to talk to it — and adopting a protocol here is much better than inventing a
request shape nobody else implements.

The costs are real and are why it is not the default path. The published
`dependencies` of `@ag-ui/client@0.0.59`, read from the installed package, are
`zod`, `rxjs`, `uuid`, `fast-json-patch`, `untruncate-json`,
`compare-versions`, `@types/uuid`, and the sibling packages `@ag-ui/core`,
`@ag-ui/proto` and `@ag-ui/encoder`, the latter two carrying protobuf
encoding. That is a substantial closure for an offline-first vault PWA, and
it is on the `0.0.x` line — an unstable version series where a patch bump is
allowed to change anything.

Both facts point at the same treatment: the transport is imported
dynamically, so a browser that never configures a remote endpoint never loads
any of it, and it sits behind `SupportAgentPort` so the protocol's instability
is contained to one adapter. A deployment that turns it on has made a
deliberate decision that prompts leave the device; the ADR records that as a
consequence rather than hiding it.

### A2UI — not chosen as the tutorial state machine

A2UI belongs to the emerging class of agent-driven UI protocols: rather than
returning prose, an agent returns a declarative description of interface, and
the client renders it. As a way to let an agent compose a form or a summary
card without the client shipping every layout in advance, it is a genuinely
good idea, and it is aimed at a real problem.

It is the wrong primitive for a tutorial in a vault, for a reason that has
nothing to do with its quality. A protocol whose purpose is *the model
describes UI and the client renders it* has the model's output growing toward
generality — that is the direction it should grow. A tutorial language in a
credential store needs its output to grow toward being **more** constrained
over time, not less. The security property we want is that the model
physically cannot express "click this" or "render this markup"; a rendering
protocol's roadmap is a steady stream of new things it can express. Adopting
one would mean permanently policing which subset we accept, which is the
behavioural enforcement this design exists to avoid.

Its specification status and governance were not verified in depth here. That
does not change the conclusion — the mismatch is structural rather than
version-dependent — but a future reader should not treat this section as a
survey of what A2UI can currently do.

### OpenUI Lang — not chosen as a runtime dependency

Same category, same conclusion, different emphasis. A language for describing
interface that a model can emit is a reasonable thing to want and a reasonable
thing to study; it was studied here as an alternative to designing GuideLang.
The reason we did not take it is that we did not want a *UI description
language* at all. GuideLang describes a **trajectory over semantic
identifiers** — point at `nav.connections`, wait for the person to activate
it — and produces no interface of its own. Its whole grammar is ten
directives. A general description language would be a much larger surface
accepted from an untrusted producer in exchange for expressiveness we
specifically do not want, and it would put a third-party parser on the path
between a model and the vault's DOM.

We are not making a claim about OpenUI Lang's maturity or licence; neither was
verified, and neither would have changed the answer.

### CopilotKit — not chosen as a mandatory dependency

The React framework for embedding a copilot in an application: a provider, a
chat surface, `useCopilotReadable` to expose application state to the model,
and `useCopilotAction` to let the model call into the app. It is the most
complete off-the-shelf answer to "put an AI assistant in my product", and the
AG-UI protocol came out of the same work.

`useCopilotAction` is precisely the design we are rejecting. The framework's
premise is that the model actuates the application through registered actions,
with safety supplied by which actions you chose to register and by how the
model behaves. In a product where the actions in scope include unlocking,
revealing, granting and approving, "we only registered safe actions" is a
promise that has to be re-made in every pull request forever, and the failure
mode of getting it wrong once is a disclosed secret.

`useCopilotReadable` has the mirror-image problem: it makes exposing
application state to the model a one-line convenience, on a page where most
application state is somebody's credentials. The privacy boundary here needs to
be a single function that assembles context from authored registries and has
no path to the DOM at all
(`apps/pages/src/tutorial/registry/context.ts`), not a hook that any component
can call.

None of that makes CopilotKit a bad library. It makes it a library for
applications whose worst case is an embarrassing action, not a disclosed
vault.

## 5. On-device inference

### Chrome's Prompt API — the first-party path

The browser's built-in language model, reached through a global that reports
availability and mints a session with a system prompt. It is the option that
makes contextual support *possible* for this product rather than merely
desirable, because it is the only one where the honest answer to "where does
my question go?" is "nowhere".

Three properties shaped the contract in
`packages/support-agent/src/contract.ts`:

- Availability is a ladder, not a boolean: unavailable, downloadable,
  downloading with progress, ready. `SupportAgentAvailability` mirrors that
  ladder exactly rather than collapsing it, because a UI that shows "AI
  support unavailable" when the truth is "click to download a model" is a
  worse product than no AI at all.
- Acquiring the model needs a user gesture and downloads a substantial
  artifact. That is a first-run ceremony, not something to trigger on mount.
- A session holds context and must be disposed. `SupportAgentPort.destroy()`
  exists so vault lock can drop the provider session and its transcript
  together, rather than leaving a conversation about the person's vault
  resident in a model session across a lock.

Its limitation is stated in the ADR as a cost rather than buried: availability
is desktop-first and depends on the device meeting hardware requirements, so a
large fraction of users will never see it. That is why the deterministic help
graph is not a fallback of last resort but the source of truth, and why the
authored guides in `apps/pages/src/tutorial/registry/goals.ts` run through the
identical parse-and-validate pipeline model output goes through. A path that
only executes when the model is missing is a path that is never exercised.

## 6. What the survey changed

Three design decisions came directly out of this assessment rather than out of
the original sketch.

The **semantic target registry** is Pendo's and Chameleon's lesson applied
before we had to learn it: selector-targeted guidance rots silently, and the
fix is a name the application owns and a binding the framework maintains.

The **`textContent`-only rendering rule** came out of reading Driver.js's
bundle rather than its documentation. Every library in section 2 accepts
markup in a popover; that is a normal feature and a hostile default for a
relay of model output.

The **decision to build GuideLang rather than adopt a rendering protocol**
came out of noticing that every candidate protocol's roadmap runs toward more
expressiveness, and that ours needs to run the other way. That is not a
criticism of A2UI, OpenUI Lang or CopilotKit. It is the difference between a
model that composes an interface and a model that is allowed to point.
