# ADR 0199 — A provider that refuses web pages is reached through an optional bridge extension, host by host

- **Status:** Accepted
- **Date:** 2026-10-12
- **Builds on:** [ADR 0185](0185-native-browser-connectors.md) (a provider connects from
  the browser only through a compiled contract that proves access),
  [ADR 0197](0197-browser-dispositions-and-honest-links.md) (a provider with no road says
  why, with evidence), [ADR 0198](0198-key-driven-providers-share-one-driver-core.md)
  (providers that connect with a person's own key share one driver core),
  [ADR 0149](0149-nothing-stored-in-the-clear.md) (nothing the client stores rests in the clear)
- **Amends:** ADR 0185 §8, where a provider whose preflight refused this origin had "no
  relay provided"

## Context

ADR 0197 and ADR 0198 gave every provider whose servers answer this origin a road. They
left the providers that do not: 27 API-key providers that the audited preflight policy
refuses (SendGrid, Postmark, Datadog, Cloudflare, Resend, …), and 17 more (16 model
providers and Plivo) that had no key check at all because the one that exists is
unreadable from a page. Their servers answer a request from
`https://opensesame-labs.github.io` without an `Access-Control-Allow-Origin` header, so a
page that sends the request cannot read whether the key was accepted. That is a rule of
the browser, not of OpenSesame: no change to the page can make it say yes.

"Unavailable" is honest, and it is not the integration a person was promised. A static
page that holds no server (ADR 0090) cannot add one that relays a person's key
(a key that passed through a hosted relay would no longer be held only by its owner, ADR 0149).
A browser *extension* is the one piece of software in the person's own browser that is not
bound by the page's CORS regime: with a host permission its `fetch` can read any answer.

## Decision

1. **A separate, optional companion extension.** `apps/browser-extension-bridge` is its own
   extension, not part of the default one (`apps/browser-extension`), so the default
   extension's permissions and threat model do not change and a person who never installs
   the bridge is unaffected. Like the autofill companion (ADR 0150 §7) it is never reached
   by the Pages bootstrap: the app asks it a question only when the connections capability is
   active, and a bridge that does not answer is *absent*, which changes nothing.
2. **The page and the extension speak a closed wire.** `packages/connector-bridge` is the one
   definition of it: three operations (`hello`, `need`, `fetch`), strict parsers used at
   *both* ends (an unknown key, a wrong type or an oversize value is not a request), bounds
   (256 KiB request, 1 MiB response, 20 s, 64 headers), and the request policy
   (`checkFetch`). The page reaches the extension through a relay content script that is
   **registered at runtime, for one origin a person switched the bridge on for**, in the top
   frame only; the manifest declares no `content_scripts`. The background answers a relayed
   message only if the browser says it came from this extension's own relay, in the top frame of
   a tab, at an origin that is switched on right now, and a popup message only if it came from
   an extension page, not a tab.
3. **Consent is per host, and a page can only ask.** The manifest has no `host_permissions`;
   every host is an `optional_host_permissions` entry that the popup requests, one host at a
   time, on the person's own click, and what is held is read back from the browser. A page may
   name hosts it needs (`need`); the bridge records the ask and lights its badge. It never
   grants. The hosts it can ever reach are a **table generated from the specs**
   (`spec/connectors/browser-policy.json`, the catalog's declared egress and each provider's
   key-check host, ADR 0139): a host the table does not name cannot be allowed at all.
4. **A request is checked as strictly as the page promised.** A bridged request is HTTPS, to
   a host in the table *for the provider it names*, with a method from a closed set, no body on
   a GET or HEAD, no `Cookie`, `Host`, `Origin`, forbidden-prefix or hop-by-hop header,
   `credentials: "omit"`, `redirect: "error"` (a redirect is refused, never followed), bounded
   in time and size, and answered as UTF-8 text. Response headers are passed back except cookies
   (`Set-Cookie`, `Set-Cookie2`), bounded in number and size. What the provider says is relayed
   as it is and never logged or kept.
5. **The request leaves as a plain client's would.** Every key check in the specs was
   established from Node, with no `Origin`. Chromium's extension `fetch` sends none on a GET but
   sends `Origin: chrome-extension://<id>` on a POST, and some providers answer an origin they
   do not know with an error where a bad key should get a 401 (Helicone answers 500, Sanity 403).
   A single `declarativeNetRequest` session rule, kept in step with the granted hosts, removes the
   `Origin` header from this extension's own requests to exactly those hosts
   (`declarativeNetRequestWithHostAccess`: it acts only where a person granted access). The
   real-Chromium test records what the provider receives.
6. **The page's side is a transport, not a second authority.** `NativeProviderTransport` already
   carries every provider call through `ctx.egress`. When the bridge holds a request's host,
   the call goes through `ctx.egress.decide` first (the operator's egress policy still
   applies) and is then carried by `bridgedFetch`; otherwise it is the page's own `fetch`,
   as before. A refusal from the bridge is a `NativeApiError` of class `bridge`, a failed
   request a `network` one, and a provider's words are still never repeated. Only the *latest*
   `hello` may change what the page believes, so the silence of an older question cannot say
   the bridge is absent after it was found.
7. **The connection form follows the road.** For an API-key method the policy refuses, the form
   draws no key field. It says what to do next (install the bridge, switch it on for this site,
   allow `host`) and links the bridge's README; once the bridge holds the host the same form
   offers the key. The page puts the provider's hosts in the bridge's popup on its own
   (`need`); it allows nothing.
8. **Evidence decides which road a provider gets.** A provider with a key check whose answer
   the audited origin cannot read is a rule in `browser-policy.json`, with the probe of its
   real key-check route (a fake key, the audited `Origin`, TLS verified). A provider whose
   authenticated route *does* admit the origin connects directly with no bridge: re-probing the
   key-check route of 17 providers ADR 0197 had recorded as refusing found that Inception's
   admits this site, so it is a direct preset and not a bridge provider. A row in
   `browser-dispositions.json` is now only for a provider with no key check to carry; the table
   is built from the policy rules alone.

9. **A provider with no key to check gets a driver that proves what it has.** Infisical Cloud
   admits only its own web app's origin and issues no pasteable key: a machine identity's
   client ID and secret are exchanged by Universal Auth's login for a token that lives for one
   call. `native-infisical.ts` is an ADR 0198 key driver whose proof is that login (bad
   credentials answer 401 in every probe; the success path is exercised against the documented
   contract only), at the two cloud regions; names and a value are read on request, a value
   shown once. It carries its calls through the bridge like any policy-refused provider.

## Scope

API-key connections only. MCP servers stream, and the bridge returns one buffered body, so
they are left out of the table. OAuth providers whose token endpoint refuses a browser, and
the local-process integrations (a keychain, `pass`, a command), are not carried by this ADR.
The extension targets Chromium and Firefox (MV3); the real-browser test is Chromium.

## Consequences

- 45 providers connect through the bridge once it is installed, switched on and the host
  allowed: the 27 the policy already refused, the 17 that gained a key check, and Infisical. Without the bridge each says what to install and why, with
  the evidence, in the words the page already used.
- The bridge never holds a key at rest, never allows a host by being asked, and does nothing
  for an origin a person did not switch on. An origin the person *did* switch on can ask it
  to send a key *that origin supplies* to a granted provider host; that is no authority the
  origin lacked, since the page could put the same key in its own request if the provider
  allowed it. The bridge adds a way to read the answer, not a way to obtain a key.
- A provider that changes its CORS policy moves the answer: `pnpm audit:browser-dispositions`
  re-probes dispositions, and the policy's probes are dated; a provider that starts to admit
  the origin should have its rule deleted and the bridge becomes unnecessary for it.
- Verification against real providers used fake keys only; no real credential was obtained.
  The refusal path is proven against each provider; the success path against the documented
  contract and a stand-in server, and in a real Chromium with the extension loaded.
