# ADR 0192 — Model providers are a category, and a key for one is issued by exchange, never shared

- **Status:** Accepted (catalog, add sheet, broker, mint/list/revoke panel and conformance vectors built and tested; the channel by which another origin presents a key is not built — §9)
- **Date:** 2026-10-11
- **Uses:** [ADR 0005](0005-authority-handle-connectionref.md) (callers hold a handle, never the credential), [ADR 0065](0065-agent-surface-parity.md) (agent-surface parity), [ADR 0090](0090-static-frontend-complete-without-backend.md) (no backend in front of the first screen), [ADR 0115](0115-front-door-and-connector-directory.md) (connectors by reference), [ADR 0128](0128-pages-without-host.md) (Pages speaks no Host), [ADR 0130](0130-operator-controlled-capability-composition.md) (optional capabilities), [ADR 0139](0139-one-definition-every-target.md) (one definition, every target), [ADR 0149](0149-nothing-stored-in-the-clear.md) (nothing stored in the clear), [ADR 0150](0150-surrogate-credentials-at-the-last-hop.md) (a surrogate selects a credential, it never becomes one), [ADR 0157](0157-logs-and-events-carry-no-secrets.md) (logs carry no secrets), [ADR 0158](0158-settings-rows-act-or-are-absent.md) (a row acts or is absent), [ADR 0161](0161-what-a-static-origin-can-be-as-an-openid-provider.md) (what a static origin can be as an OpenID provider), [ADR 0178](0178-authorization-checks-are-proofs-the-compiler-can-see.md) (authorization is a proof)
- **Standards:** RFC 8693 (token exchange), RFC 8707 (resource indicators), RFC 9396 (rich authorization requests), RFC 9449 (DPoP), RFC 7009 (revocation), RFC 6749 §5.2 and RFC 6750 (error answers)

## Context

Two things were wrong with how a person used a model provider through
OpenSesame.

**Connecting one was a page, not an act.** Providers were spread over several
categories, five of them were known to the browser by hand (`HOSTED_MODEL_PROVIDERS`),
and adding one meant finding its connector page and reading it. Tools that only
ever do one thing here — OpenCode's "Connect Provider" is the model — show a
grid, take a name and a key, offer a test, and save.

**Using one meant giving the app the provider's key.** OpenSesame is an auth
broker for connectors; an app or agent that wants a model should be handed
something of OpenSesame's, narrowed to what it needs, that ends on its own and
can be revoked, and the provider's credential should stay where it is sealed.
ADR 0150 already says the broker re-places a credential at the last hop;
nothing yet said how an app *asks for* what it may use.

The constraint that shapes the answer is ADR 0090 and ADR 0161: the front end
is complete without a backend, and a static origin has no endpoint of its own to
be a token endpoint. Whatever issues and checks these keys is code in the page that holds
the credential, in that page's memory, for as long as it is unlocked.

## Decision

### 1. AI model providers are their own category

`spec/connectors/catalog.json` gains the category `ai_model_provider` and every
hosted model provider moves into it (ADR 0139: written once, consumed by the
Rust broker, the OpenAPI, the generated TypeScript and the presets). A row in
the category carries a `model_api` block:

```json
"model_api": { "protocol": "openai_chat", "base_url": "https://api.openai.com/v1" }
```

`protocol` is a closed name — `openai_chat`, `anthropic_messages`,
`gemini_generate_content` or `rest_json` — and nothing else about how a
provider is spoken to is read from anywhere but the catalog. A row's
`base_url` must lie inside the egress its own `verify` rule names (the broker's
catalog tests refuse a row that names a host its egress does not), a row
outside the category may not carry the block, and a row whose endpoint is the
person's own (`configuration` kind: a gateway, a cloud account) carries a
protocol and no URL. The catalog holds 84 such rows.

Whether a provider can be tested **from a browser** is a fact about its CORS
policy, not about our code, so it was measured and not assumed: an
unauthenticated `GET {base}/models` (a 401 or 403 means auth is required, not
that the route is absent) and `OPTIONS` preflights for GET and POST from the
audited origin `https://opensesame-labs.github.io`. Only a provider that
passes gets a connect preset, and so a **Test connection** key. The rest are
still listed, still in the category, and are connected where a browser can
reach them (the desktop host); the tile says nothing a person cannot act on.

### 2. Adding one is a sheet

Choosing a provider tile opens one sheet (`AiProviderSheet`): a name, the key,
**Test connection** — which sends the key to the provider's verify host, the
one its connect preset names, and keeps nothing — and **Save connection**, which
verifies the key first (`configureNativeApiConnector`: verify, then seal).
There is no page to read and no method to choose. The key is sealed on the
device under ADR 0149. Test and Save send it to the provider's verify host and
nowhere else (no redirect is followed); the sheet names that host, read from the
request the connector runtime builds. It is not always the `model_api` host:
Hugging Face verifies at `huggingface.co` and serves models at
`router.huggingface.co`.

### 3. A model key stands for a connection without being it

An app or agent is handed a **model key**: `osk_` followed by 43 base64url
characters. The prefix belongs to no provider, so a leak is recognisable
(`spec/log-scrub/log-scrub.json` has a rule for the shape and the WebMCP and
observability agent-payload fences refuse it). The broker keeps the key's
SHA-256 and nothing else, in memory; **a lock, a reload, a closed tab or a
disabled capability ends every key**, which is the right lifetime for a
credential whose backing secret is sealed at rest.

Every key is an `AuthorityGrant` (`@opensesame/os-domain`), so the same
attenuation law (INV-GA-01) that governs every other grant governs these:

- a **root key** is made only from a *draft* the person approved. The draft is
  digested over every field of the grant (issuer, client, connection,
  resource, actions, models, the four budget numbers, lifetime, delegation
  depth, proof key) and `proveModelGrantApproved` mints the gdp-ts proof
  `ModelGrantApproved<G>` only if the approver *is* the issuer, the method is a
  passkey or the unlocked vault's custodian after the `manage_grants` check
  (which carries the duress ceilings), both the sign-in and the approval are
  fresh, and the approval is bound to **that** digest. `issueRoot` takes the
  proof as a parameter; nothing else in the tree can write "approved", and a
  draft edited after the person looked at it is a different draft with no
  approval (`proofs/model-grant-approval.mistakes.ts`). For the custodian
  method the approval is the person's press of Create on the sheet. The sheet
  reports a `MintConfirmation`, the digest of the draft as it displayed it at
  the press and the press time, and `mintModelKey` builds the approval evidence
  from it. It refuses a draft whose digest is not the confirmed one
  (`approval.digest_mismatch`) and a press older than 30 seconds
  (`approval.stale`), and issues nothing. This binds a key to what the sheet
  showed and to an explicit, recent press. It is not proof against a script
  running in the page, which holds the open vault and can construct a
  confirmation itself; no check inside a same-origin page can be. A passkey
  approval (a WebAuthn assertion over the digest) is the stronger method the
  prover already accepts, and the sheet does not yet use it. An approval is
  spent by the key it issues: `issueRoot` refuses a second use of the same
  approval (`access_denied`, reason `approval.spent`), including concurrent
  attempts and after a lock; spending is tracked on the named draft the proof
  is about, because the proof object itself is shared. A press is spent too: the
  same confirmation presented twice makes one key (`approval.spent`).
- a **derived key** is made by exchange (§4) and can only be narrower.

### 4. The exchange is RFC 8693, strictly

`ModelKeyBroker.exchange(params, context)` takes the parameters of an RFC 8693
request and answers with the fields of its response.

| Parameter | Handled |
|---|---|
| `grant_type` | exactly `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token`, `subject_token_type` | an `osk_` key, type `access_token`; any other type is refused |
| `requested_token_type` | absent, or `access_token` |
| `resource` (RFC 8707) | one canonical `https` URI naming a catalog provider (§5); must agree with the detail's `locations` |
| `audience` | `urn:opensesame:model:<provider>`; the same provider only |
| `scope` | `model.invoke`, `model.list`; must agree with the detail's `actions` |
| `authorization_details` (RFC 9396) | exactly one `model_access` detail (§4.1) |
| `dpop_jkt` (RFC 9449 §10) | binds the new key to a proof key |
| `actor_token`, `actor_token_type` | **refused**: delegation is represented by the key's `act` chain, not by a second token |
| anything else | **refused**, never ignored — an ignored parameter is a request the caller believes was honoured |

Parameters arrive as flat strings the way a form or a channel message carries
them; the request is capped in count and size before anything is parsed; a
name given twice is refused (RFC 6749 §3.1).

**4.1 The `model_access` detail.** Members are a closed list: `type`,
`locations`, `actions`, `models`, `budget`, `lifetime_seconds`. A member that
would widen something the broker has no check for cannot ride along as an
"extension"; card data is refused by `assertNoPaymentCredentials`; a model is
an id, `namespace/*` or `*`.

**4.2 A key can only be narrowed, and a request for more is refused, not
trimmed.** Each dimension is checked on its own against what the parent holds
*now* (not what it was issued with), and an excess is `invalid_target`,
`invalid_scope` or `invalid_authorization_details` — never a quiet smaller
grant. Trimming turns a probe into a map of the parent's limits and tells a
client that asked for `gpt-4o` and was given `gpt-4o-mini` something false.
Time is the one exception: a lifetime longer than the parent's is shortened
and `expires_in` says so (RFC 6749 §5.1), because a shorter life is never more
authority. The result is checked a second time by
`validateAuthorityGrantAttenuation`, so the broker's reading of "narrower" and
every other plane's cannot drift.

**4.3 Authority is conserved.** The consumables (`requests`, `input_tokens`,
`output_tokens`) of a child are *carved out* of its parent's remaining budget
at the moment of the exchange; `max_output_tokens` is a per-request cap and is
never spent. Two children cannot together hold more than the parent had, a
revoked child gives its unspent budget back, and a child that ends returns what
it did not use. The number of live children, the depth of the chain
(`maximumDelegationDepth`, at most 3 and by default 2), the number of keys
(256) and the number of in-flight calls per key (8) are bounded. Only children
that are neither revoked nor expired count toward the limit of 32. Ended
children's rows are freed on the next exchange or root issue, and their unspent
allowance is returned to the parent exactly once. An exchange refused for lack
of room (`ledger.full`) leaves its parent unchanged.

**4.4 Sender constraint.** A key may be bound to a proof key (`dpop_jkt`), and
then a call must carry an RFC 9449 proof: ES256 only, `typ: dpop+jwt`, an
embedded public key with exactly the members of an EC P-256 JWK, `htm`/`htu`
matching the call (`htu` without query or fragment), `ath` equal to the hash of
the key, `iat` inside a window (300 s back, 60 s ahead), and a `jti` that has
not been seen — the replay cache lives as long as a proof can be presented. The
proof's key must be the one the key is bound to. To exchange a bound key the
caller proves it holds that key (`htm: POST`, `htu` the token endpoint, `ath`
the subject key's hash). The child is bound to `dpop_jkt` when the request
names one — handing a narrower key to a different holder, which the parent's
holder has just authorised by proving possession — and otherwise to the same
key; a child of a bound key is never unbound. Policy `dpop_required` (the broker's default) refuses an unbound
issue; Pages runs `dpop_optional` (§8) because a page cannot attach a proof key
to a request it did not make.

**4.5 Refusals teach nothing.** The wire answer is one of the RFC's error
codes; the **reason** is a stable machine word in the audit event and never
the wire. A key that is unknown, expired, revoked, someone else's or for
another resource is *one* answer (`invalid_token`). The order of checks is
deliberate: shape, then who is asking, then proof of possession, and only then
what was asked for — so a thief who holds only a key learns nothing about what
it would allow.

**4.6 The ledger can change while an exchange waits.** Hashing and proof
verification are asynchronous; the commit that writes the child looks the
parent up again and re-checks it synchronously, so a key revoked while its
exchange was in flight is not extended. The clock never runs backwards inside
the broker, and the audit sink may throw without changing a decision.

### 5. Audience: the resource indicator is canonical or it is nothing

A key is bound to an audience by comparing strings, which is safe only if the
strings are canonical, and canonical here is strict: `https`, a lower-case
ASCII host with no userinfo, no default or explicit port, no query, no
fragment, no dot segments, no encoded characters, no trailing slash. Anything
else is **refused rather than repaired**, because a repair that guesses is how
`api.example.com.evil.test` and `api.example.com@evil.test` come to mean the
same thing. A resource resolves to a provider only through the catalog
(`modelTargetForResource`); a host the catalog does not name is no resource.

### 6. Spending a key: the last hop

`authorize(key, call)` is the only road from a key to a provider call, and it
answers with the URL, the method and the **body to send** — never a header and
never a credential. The caller names a route relative to the provider and a
body; the broker:

1. reads what the call *is* (route, model, output limit) before consulting the
   grant;
2. checks the key (active, this client, this resource, proof of possession when
   bound), then the grant (action, model, output cap);
3. refuses any request field not on its protocol's allowlist — an unlisted field
   (`n: 100`, a search tool, an audio output, `stream`) is a feature nobody
   priced, and a budget that cannot see a cost cannot hold it. A tool must be a
   plain client-side function declaration: `tools`, `tool_choice` and
   `toolConfig` are held to a closed shape per protocol (`body.tool`), so a
   search, code-execution or computer tool the provider runs and bills for is
   refused whatever it is called;
4. requires the call to state its output limit and to stay inside the key's,
   and reserves its **worst case** from the budget, all or nothing. A body the
   authority would refuse before sending (an array over 100 items, an object
   over 100 keys or a key over 4096 characters, a string over 65,536
   characters, nesting past ten levels) is refused at inspection
   (`body.limits`) and reserves nothing;
5. returns the body it inspected — the object, not a second reading of the
   caller's bytes.

`invokeWithModelKey` then sends it through the connection's own authority
(`hostedModelAuthority().execute`), which attaches the saved credential and
re-checks the host against that connection's egress, and settles the
reservation exactly once whatever happens: what the provider reported is
charged, a failure after the request may have left keeps the worst case
charged, and a call stopped before anything left refunds. The authority says
when a request can leave (`onDispatch`, called once immediately before the
fetch): a failure before it refunds, a failure after it keeps the worst case
charged, and an answer always counts as sent. The key itself is
never sent upstream (`native-model-keys-runtime.test.ts` asserts the egress
call carries the saved credential and no `osk_`).

### 7. Where a key can and cannot be presented

- **In the page that holds it**, by code the person's browser runs: the library
  (`lib/model-keys/`) and the Keys panel.
- **Not by MCP or WebMCP.** A tool call does not say which client is calling, a
  key is only good in the hands of the client it was issued to, and tool results
  are fenced against anything shaped like a key. Creating, listing and revoking
  keys is the person's act and no agent's (ADR 0065 exclusions in
  `packages/capability-registry/src/model-keys.ts`).
- **Not by the CLI.** Keys live in a page's memory; a terminal has no page.

### 8. The Pages policy and the Keys panel

The Pages broker is bound when External connectors is active
(`bindNativeModelKeys`), reads the saved connection's facts from the native
store, and is reset on vault lock and on disposal. Its policy is the default
with `dpop_optional`. A connected, verified API-key model provider whose
protocol is one of the three inspected ones gets a **Keys** panel on its
connection page: a key to create one, a row per key (name, models, requests
left, time left, status) and a bin key to revoke. Creating one is a sheet: the
app or agent's name, the models (`gpt-4o, gpt-4o-mini`, or **Any model**), one
of three budgets and one of two lifetimes; the vault's `manage_grants` check
runs, the press that creates the key is bound to the digest of the draft the
sheet showed, and the key is shown once with a copy key. Closing the sheet
forgets it, and the sheet cannot be dismissed while a key is being made; a key
that finishes after its sheet is gone is revoked at once; Done ignores any
activation within 600 ms of the key appearing, so the press that made the key
cannot also close over it. Budget and lifetime are native radio groups with
visible labels. 70 of the 84 model
rows can be given keys; the other fourteen are the five `rest_json` providers
(no inspectable routes) and nine whose endpoint is the person's own.

A `Settings` row acts or is absent (ADR 0158): the panel draws nothing where no
broker is bound or the provider cannot be given keys.

### 9. What this does not do yet

- **No channel for another origin.** The exchange and the spend are functions
  in the page. An app on another origin, or an agent in another process, needs a
  way to reach them: a popup and `postMessage` transport in the style of
  browser-local IAM (exact origin binding, PKCE, consent), or the Host's token
  endpoint (the Rust plane is a server and may host one). Both would reuse the
  broker unchanged and are the next slice; this ADR does not pick between them.
  Until then the keys are usable by in-page callers only, and the panel says
  nothing that suggests otherwise.
- **No durable audit trail.** Events (`root.issued`, `exchange.issued`,
  `exchange.refused`, `call.authorized`, `call.refused`, `call.settled`,
  `key.revoked`) are value-blind and go to a sink; Pages keeps the most recent
  200 in memory (`audit-ring.ts`), emptied on a lock and when the capability is
  released.
  The Access audit's event names are frozen ([ADR 0015](0015-audit-vs-diagnostic-logging.md)) and adding to them is a
  separate change.
- **`rest_json` and own-endpoint providers cannot be given keys.**

## Edge cases the tests pin

The conformance vectors (`spec/conformance/model-key-exchange-vectors.json`,
25 cases, replayed by `vectors.test.ts` and available to any other plane) and
the suites around them cover, among others:

| Attack or mistake | Outcome |
|---|---|
| a child asks for a model, action or budget its parent lacks, or "all models" from an exact list | refused (`escalation.*`), never trimmed |
| a longer lifetime than the parent's | shortened, `expires_in` states it |
| another provider's resource, or the same host spelled another way | refused (`escalation.resource`, `resource.*`) |
| two children that together exceed the parent; a 33rd child; a chain deeper than the root allows | refused (`escalation.budget_remaining`, `children.limit`, `depth.exceeded`) |
| a revoked child's unspent budget | returned to the parent exactly once |
| a refused exchange (`ledger.full`) | the parent's budget is unchanged, however often it is retried |
| one approval, or one press of Create, used twice | refused (`approval.spent`) |
| `__proto__` or a repeated parameter in a query string | refused (`param.unknown`, `param.duplicate`) |
| a broker replaced by another | the old one's keys end |
| a key exchanged by a client it was not issued to | `invalid_grant` (`subject.foreign_client`) |
| a revoked, expired or unknown key, at the exchange or at a call | the same answer for all three |
| a revoke racing an exchange (the hash is held while the parent is revoked) | the child is not issued |
| an unknown parameter, `actor_token`, a wrong token type, `scope: admin` | refused, never ignored |
| `__proto__`, `constructor`, inherited or non-plain members in the request or the detail | refused |
| a call on `gpt-4` from a `gpt-4o` key, or a model spelled to slip past a prefix | refused (`escalation.model`) |
| a call with no output limit, or one above the key's | refused (`tokens.required`, `escalation.tokens`) |
| `n`, `stream`, tools the protocol does not allow, an unknown field | refused (`body.*`) |
| a provider-run tool (`web_search`, `google_search`, `code_interpreter`, …), alone or beside a function tool | refused (`body.tool`) |
| a request the authority would refuse locally (101 messages, a credential in the body) | refused at inspection (`body.limits`) or refunded, never charged |
| a route outside the protocol's, dot segments, an encoded slash | refused (`call.route`) |
| a budget spent, and a worst case that does not fit | refused (`budget.exhausted`); a call that never left refunds |
| nine concurrent calls on a key | the ninth refused (`inflight.limit`) |
| DPoP: wrong key, `alg: none`, wrong `htm`/`htu`/`ath`, stale or future `iat`, replayed `jti`, extra JWK members, a private key in the header | refused |
| a bearer key presented where a bound one is required, and the reverse | refused |
| property tests over random operation sequences | no child ever holds more than its parent, and the sum of live allocations never exceeds the root |

## Consequences

- An app or agent can be given a model without being given a provider key, for
  a bounded time and spend, and the person can end it. The provider's
  credential is never in the app's hands.
- The category change touches the catalog's consumers; the generated artifacts
  are regenerated, and a row anywhere that is a model provider and not in the
  category fails a catalog test.
- Pages gains one dependency, `jose` (DPoP proofs are verified with the library
  and not by hand).
- A key issued here is worth nothing after a lock or a reload. That is the
  design, and it is also the limit: an unattended agent that needs a key across
  a lock needs the Host plane's endpoint (§9).
