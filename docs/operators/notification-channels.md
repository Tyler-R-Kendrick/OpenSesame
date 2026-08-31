# Notification channels and approval ceremonies

Operator guide for ADR 0081. How to configure where people are told about
authorization requests, and what each channel can and cannot be trusted to do.

## The one rule

A person's channel preference chooses **where they are interrupted**. It never
chooses **what it takes to approve**. Those are separate mechanisms, composed in
one direction:

```
policy ∩ preference ∩ live bindings ∩ configured adapters
```

A preference can reorder and narrow. It cannot admit a channel policy did not
allow, and it cannot lower an assurance requirement. If you take one thing from
this page: **turning on Slack does not make Slack able to approve production
access.**

## Capability matrix

What each adapter in this repository can actually demonstrate — not what the
vendor's product page says is possible.

| Channel | Notify | Rendezvous | Bound external identity | Direct approve | Phishing-resistant by itself |
|---|---|---|---|---|---|
| In-app + transaction-bound WebAuthn | yes | yes | OpenSesame principal | policy | **yes**, when the verified facts satisfy it |
| Web Push (W3C/VAPID) | yes | yes | device subscription | no | no |
| Slack | yes | yes | workspace id + user id | policy opt-in | no |
| Microsoft Teams | yes | yes | tenant id + user id | **unsupported** | no |
| Telegram | yes | yes | bot-bound numeric user id | policy opt-in | no |
| WeChat | yes | yes | app id + OpenID | **unsupported** | no |
| SMS | yes, when a bridge is configured | yes | verified phone binding | **unsupported** | no |
| Generic webhook | yes | no | endpoint, not a person | **unsupported** | no |

Note that requiring a transaction-bound activation rules out external
settlement entirely, and every default policy above `low` requires one. So in
practice Slack and Telegram can only ever settle requests an operator has
classified `low` risk *and* explicitly opted that channel into. The
`interactive` ceiling is a ceiling, not a default.

### Freshness

A callback that can be replayed later is a decision that can be made twice.
Two mechanisms establish freshness, and a channel has exactly one of them:

- **A signed provider timestamp** — Slack and WeChat put a time inside the
  string they sign, so a captured request stops verifying once the window
  closes.
- **A one-time server-minted reference** — Telegram stamps a button press with
  nothing, so its callback carries an opaque token we minted and the replay
  ledger retires on first use.

A callback that establishes neither is refused. So is one claiming a provider
timestamp on a channel whose provider does not send one — that describes a
check that did not happen.

"Direct approve: policy opt-in" means the adapter *can* carry a decision and
still will not unless an operator names that channel in
`directApprovalChannels` **and** the request's assurance requirement is one the
channel can meet. Every shipped default policy has that list empty.

"Unsupported" is a structural fact, not a gap in the configuration. Those
adapters declare `canRenderDecisionActions: false`, and the policy normalizer
strips them from `directApprovalChannels` even if an operator writes them in.

### Why three channels cannot approve

- **Teams** — inbound action provenance requires a Bot Framework channel with a
  publicly reachable messaging endpoint and Entra token validation. Accepting an
  unverifiable POST as a human decision would be worse than not offering it.
- **WeChat** — interactive approval needs a verified service account and a
  per-user OpenID from an authorization flow that cannot be exercised offline.
  The message callback signature is checked, so provenance is real; a *decision*
  is never extracted from it.
- **SMS** — a phone number is a lease from a carrier. SIM swap and number
  reassignment both transfer it with no involvement from the holder.

## No paid dependency

Nothing here requires a subscription to build, test or run OpenSesame.

- **Web Push** is RFC 8291 (aes128gcm) plus RFC 8292 (VAPID) implemented over
  `node:crypto`. There is no push SaaS and no account to open.
- **SMS ships no carrier SDK.** The adapter defines a generic bridge contract:
  you point it at an HTTPS endpoint you host, and it POSTs a Standard
  Webhooks-signed message you verify with any Standard Webhooks library. With no
  bridge configured the channel reports itself unavailable and routing falls
  through to the next preference. It never reports a delivery it did not make.
- **Slack, Teams, Telegram and WeChat** need credentials for *your own* app in
  *your own* workspace/tenant, which those platforms issue at no cost for this
  use. Every automated test runs against local fixtures and fake transports; no
  test needs a live account.

## Configuring a channel

An unconfigured adapter is reported as unconfigured everywhere — in
`GET /v1/notification-channels`, in the effective-route response's `excluded`
list, and on the settings screen. It is never presented as working.

### Slack

Create a Slack app in your workspace with the bot scopes needed to DM users.
Supply:

- the **bot token** (`xoxb-…`) — delivery
- the **signing secret** — inbound request verification

Inbound interactions are verified with Slack's official v0 scheme: HMAC-SHA256
over `v0:{timestamp}:{raw body}`, compared in constant time against
`x-slack-signature`, rejecting anything more than five minutes from now. The
body is parsed only *after* that check passes. Identity is taken from `team.id`
and `user.id` — never from an email address or display name.

### Telegram

Create a bot with BotFather. Supply the **bot token** and a **webhook secret
token** of your choosing; set the latter when registering your webhook so
Telegram echoes it in `x-telegram-bot-api-secret-token`, which the adapter
compares in constant time. Identity is the numeric `from.id`, never `@username`.

### Microsoft Teams

Supply an **incoming webhook URL** for the channel or chat. Notifications carry
a Review link only. There is no inbound path.

### WeChat

Supply the Official Account **app id** and **callback token**. The adapter
performs the official signature check (SHA-1 over the sorted concatenation of
token, timestamp and nonce). Notification and rendezvous only.

### SMS

Supply a **bridge URL** you host and a **signing secret**. The adapter POSTs
`{to, body}` signed as a Standard Webhook; your bridge verifies the signature
and hands the message to whatever carrier or gateway you already use. Leave it
unset and SMS stays unavailable.

### Web Push

Generate a VAPID keypair and supply it. The public key is served from
`GET /v1/notification-channels/push/key` and is public by design; the private
key signs the VAPID JWT and never leaves the server. Subscriptions are stored
and never returned — a push endpoint is a capability URL, and anyone holding one
can push to that browser.

## What a notification may contain

Bodies are rendered at the *lower* of the channel's confidentiality class and
the policy's, and the classes are:

- **minimal** — that authorization was requested, plus an opaque rendezvous
  reference. Nothing about what is being asked.
- **descriptive** — adds the binding message and a short action label.
- **full** — the in-app surface only, after authentication.

Never present in any external body, structurally rather than by convention:
secrets, credentials, tokens, WebAuthn challenge material, the comparison code,
recovery material, raw principal ids, or `authorization_details` beyond what the
class permits. Requester-supplied text is sanitized (bidi controls, C0/C1,
zero-width characters stripped; provider markup escaped) before it is rendered.

The comparison code in particular is *absent by construction*: the render input
type has no field for it. The whole point of number matching is that the person
carries the value from the surface that started the request to the surface that
approves it. A code that arrives in the same message as the prompt compares
nothing.

## Setting policy

A policy names, for a class of operation:

- `requiredAssurance` — the real gate, evaluated by `@opensesame/trust-broker`
- `allowedChannels` — where a prompt may go at all
- `directApprovalChannels` / `directDenialChannels` — which of those may settle
- `requireTransactionBoundActivation` — a fresh WebAuthn ceremony bound to this
  exact transaction
- `requireComparison` — number matching
- `maximumApprovalAgeSeconds`
- `maximumNotificationConfidentiality`

Two things are enforced structurally rather than left to your care:

1. A channel not in `allowedChannels` is stripped from the direct lists.
2. A channel whose capabilities cannot carry a decision is stripped from the
   direct lists regardless of what you wrote.

Requiring a transaction-bound activation implicitly rules out every external
channel, because a WebAuthn ceremony cannot run inside a chat message. That is
the intended way to say "this one comes back to the app".

High-risk operations — root/admin access, credential recovery, authenticator
binding or replacement, recovery-destination changes, secret export, MFA
disablement, high-impact impersonation, privilege escalation, and any change to
who may approve in future — should keep the default: notify externally, review
in-app, approve with a fresh transaction-bound passkey.

## Denial is not automatically safe

A low-assurance denial cannot escalate privilege, but it can deny service. It is
modelled separately (`directDenialChannels`) and still requires a verified bound
identity and an authenticated provider callback. For especially disruptive
operations, require the full in-app ceremony for denial too.

Separately, every review surface offers **"I don't recognize this request"**.
That path raises a security event and refuses the request without granting any
authority, and it is deliberately built not to amplify notifications — reacting
to prompt-spam by sending more messages is the attack, not the defence.

## Anti-fatigue

Durable, because a limit one replica cannot see is not a limit:

- duplicate pending requests with the same canonical digest are deduplicated
  rather than prompting twice
- per-requester→approver and per-approver prompt rate limits
- comparison-code attempt budgets that re-issuing does not refill
- binding-challenge attempt budgets
- a provider callback replay ledger, where the insert *is* the claim

The `slow_down` poll pacing in the authorization-request route remains an
explicitly non-security courtesy for well-behaved clients, and must stay that
way — nothing security-relevant is decided from it.

## Failure behaviour

- A delivery failure never changes authorization state. The request stays in the
  inbox, pollable, until it is decided or expires.
- Delivery retries with bounded exponential backoff, then dead-letters. A
  dead-lettered delivery has approved and denied nothing.
- With no channels configured at all, requests still arrive in the durable inbox
  and no phantom delivery is recorded as successful.
- When a preferred channel fails permanently, routing falls through to the next
  step **already in the plan** — never to a channel policy or bindings excluded.
