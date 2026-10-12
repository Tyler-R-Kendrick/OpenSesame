# Notification channels and approval ceremonies

Operator guide for [ADR 0084](../adr/0084-external-authorization-notifications.md). How to configure where people are told about
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

### Why Teams, WeChat and SMS cannot approve

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

The subsections below describe each adapter's configuration
(`packages/notification-adapters/src/adapters/`). What a process builds from its
environment today is narrower:

- **Web Push** — the Identity API and the identity worker, from the
  `OPENSESAME_WEBPUSH_*` variables below. It is the only adapter the worker
  builds.
- **Slack** — the Identity API verifies Slack interaction callbacks at
  `POST /v1/notification-callbacks/slack` when `OPENSESAME_SLACK_SIGNING_SECRET`
  is set. No variable carries a bot token, so no process delivers to Slack.
- **Telegram** — `OPENSESAME_TELEGRAM_WEBHOOK_SECRET` is read, but the callback
  adapter is built only from a bot token and webhook secret that the Identity
  API's configuration does not carry, so none is constructed.
- **SMS** — `OPENSESAME_SMS_BRIDGE_URL`, `OPENSESAME_SMS_BRIDGE_SECRET` and
  optionally `OPENSESAME_SMS_SENDER_ID`. The Identity API uses it only to send
  the one-time second-step code.
- **Teams, WeChat, generic webhook** — adapters in the package; no process in
  this checkout builds them from its environment.

`OPENSESAME_NOTIFICATION_CHANNELS` lists the channels the Identity API offers,
and `OPENSESAME_DIRECT_APPROVAL_CHANNELS` / `OPENSESAME_DIRECT_DENIAL_CHANNELS`
name the ones allowed to settle by provider callback (both empty by default;
unknown names are dropped).

### Slack

Create a Slack app in your workspace with the bot scopes needed to DM users.
Supply:

- the **bot token** (`xoxb-…`) — delivery
- the **signing secret** — inbound request verification

Inbound interactions are verified (`OPENSESAME_SLACK_SIGNING_SECRET`) with
Slack's official v0 scheme: HMAC-SHA256
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

Supply a **bridge URL** you host and a **signing secret**
(`OPENSESAME_SMS_BRIDGE_URL`, `OPENSESAME_SMS_BRIDGE_SECRET`). The adapter POSTs
`{eventType, to, text}` (plus `senderId` when `OPENSESAME_SMS_SENDER_ID` is set)
signed as a Standard Webhook; your bridge verifies the signature and hands the
message to whatever carrier or gateway you already use. Leave it unset and SMS
stays unavailable. For the second-step code the Identity API also accepts
`OPENSESAME_TWILIO_ACCOUNT_SID`, `OPENSESAME_TWILIO_AUTH_TOKEN` and
`OPENSESAME_TWILIO_FROM_NUMBER`, and prefers them to the bridge.

### Web Push

Web Push reaches a person's enrolled browsers with a closed, content-free
wake-up. Nothing needs a vendor account; the push services (FCM, Mozilla,
Apple) only ever carry ciphertext.

**1. Generate a VAPID key pair, once.**

```bash
pnpm --filter @opensesame/notification-adapters generate:vapid mailto:ops@example.com
```

It prints the three `NAME=value` lines named in the table below on stdout, so
you can pipe them into a secret store; a reminder to keep the private key secret
goes to stderr. Replacing the pair later invalidates every existing browser
subscription, because browsers subscribe under the public key.

**2. Set the environment.**

| Variable | Where | Meaning |
|---|---|---|
| `OPENSESAME_WEBPUSH_PUBLIC_KEY` | Identity API and worker | base64url uncompressed P-256 point (65 bytes). Public by design; served at `GET /v1/notification-channels/push/key`. |
| `OPENSESAME_WEBPUSH_PRIVATE_KEY` | worker (and the Identity API, if it should offer `native_push` by itself) | base64url P-256 private scalar (32 bytes). **Secret.** Signs the VAPID token; never leaves the process. |
| `OPENSESAME_WEBPUSH_SUBJECT` | with the private key | `mailto:` or `https:` contact (RFC 8292 §2.1). Push services use it to reach you. |
| `OPENSESAME_NOTIFICATION_CHANNELS` | Identity API | Comma-separated channels it offers. Default `in_app`. |

Validated at boot, in the API and in the worker: a malformed public key, a
private key that is set without a public key or a contact, and a private key that
does not derive the public key each **refuse to start** (a half-working signing
identity otherwise fails one push at a time, far from the cause). With **no
private key** Web Push is simply off: the worker has no adapter, every plan
collapses to the inbox, and `GET /v1/notification-preferences/effective` reports
`native_push` as `adapter_unavailable`, because that is the truth.

**3. `native_push` is offered when VAPID is configured.** If the Identity API has
all three variables it adds `native_push` to its channel list by itself; you do
not need to also list it. If only the worker holds the private key (the API has
just the public one, which is the least-privilege split), list it yourself:
`OPENSESAME_NOTIFICATION_CHANNELS=in_app,native_push`. Listing `native_push`
with no public key refuses to start, since nothing could enrol under it.

**What is delivered.** A push is a wake-up, not a message. The payload is
exactly `{"kind", "action", "ref"}`: the notification class
(`authorization_request`, `authorization_decision`, `security_event`), a closed
action label (`review`, `decided`, `none`) and the request's opaque reference.
The Pages service worker draws its own title and body from tables compiled into
the page and builds the click target `approve/<ref>` from `ref` alone. No
binding message, requester, authorization details or principal id is in the
payload, encrypted or not, and a `ref` the worker would refuse to put in a URL is
omitted rather than sent. A push is sent only when the person's preference for
that class names `native_push` and policy allows it; the inbox is always last.

**Enrolment.** `POST /v1/notification-channels/push/subscriptions` stores the
browser's endpoint and keys. It answers `400 invalid_request` for what could
never be delivered to: a non-HTTPS endpoint, userinfo, a loopback, private or
metadata host, a `p256dh` that is not a canonical base64url, uncompressed P-256
point on the curve, an `auth` that is not 16 bytes.

- **One spelling per endpoint.** The endpoint is normalized before it is stored
  and digested: WHATWG URL serialization (lower-case host, default port dropped,
  dot segments resolved), no fragment, no trailing dot on the host, percent
  escapes spelled one way. A case, port, fragment or escape variant of a URL that
  is already registered is the same endpoint, not a second row. Rows written
  before this keep working: browser-issued endpoints are already in this form, so
  their digest did not change, and a row keyed on a non-canonical raw string is
  still matched when that exact spelling is presented (another principal gets
  `409`; the owner's row is carried over and the old one retired).
- **Owner-held.** An endpoint is a capability URL, so a live row stays with
  whoever registered it: another principal presenting it gets
  `409 endpoint_already_registered` and nothing moves. A row its owner has
  unsubscribed from (or that was retired as dead) can be registered by someone
  else, which is how one browser changes hands after a sign-out. A client that
  gets that 409 should drop its browser subscription and enrol a fresh one.
- **Capped.** A principal holds at most **10** live subscriptions. The 11th
  answers `409 subscription_limit_reached`; re-subscribing one already held, or
  unsubscribing one, never counts against it, and concurrent registrations can
  not exceed the cap (a recount after the write withdraws the loser).
- `DELETE /v1/notification-channels/push/subscriptions/:id` disables the row only
  if it is still the caller's, in the same write. Someone else's, or none,
  answers `404`; repeating your own unsubscribe is a `204`.

**Dead subscriptions.** After a send, a `404` or `410` from the push service
means the subscription is gone: the row is disabled and not tried again, and it
is logged by id and endpoint digest only, never the endpoint. A subscription that
can never be delivered to is retired the same way: keys that do not encrypt, a
non-HTTPS endpoint, or a private one, including a public-looking DNS name that
resolves to a private address (every resolved address is judged and the
connection is pinned to the verified one; a resolver that merely fails or finds
nothing is retried, so an outage retires nothing). A `401` or `403` is *your*
VAPID identity being refused, and a failure while signing is likewise yours
(`vapid_signing_failed`): neither retires a subscription, and the row fails
permanently and loudly. A `5xx` retries with the shared backoff and dead-letters
at the cap. If any one of a person's browsers took the push the row is delivered
(the others are not rung twice); if every browser is gone, or there are none, the
row dead-letters and routing falls through to the next step in the plan, the
inbox at the last.

**One receiver cannot stall the queue.** A dispatch pass is bounded: 8 deliveries
in flight, at most 2 for one principal (per endpoint for webhooks), 20 seconds
per delivery. A person's subscriptions are pushed side by side and no send
starts once there is no time left for it to finish; a delivery that hits the
deadline is retried like any transport failure. A claim also leases the row for 5
minutes (`DELIVERY_LEASE_MS`), longer than the slowest possible pass, so a second
worker replica, or the next tick after a slow one, does not send the same row
again; a worker that dies mid-send has its row retried after the lease, having
burned the one attempt the claim counted.

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
- A Web Push subscription the push service reports gone (404/410) is disabled
  so it is not tried again; see [Web Push](#web-push).
- When a preferred channel fails permanently, routing falls through to the next
  step **already in the plan** — never to a channel policy or bindings excluded.
