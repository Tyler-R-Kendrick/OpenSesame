# Deadman switch relay contract

The Pages deadman switch (ADR 0209) keeps the release package and the release
key on one device. A relay is the independent clock and heartbeat witness; a
webhook is the trusted endpoint that receives the event. This guide is the
contract between the browser, the relay and the webhook. It is deliberately
small enough to implement on a cron-backed worker, a serverless timer or an
existing heartbeat monitor.

## What the browser sends

All requests are `POST` with `content-type: application/json` and at most
64 KiB. The relay URL must be HTTPS. `http://127.0.0.1`, `http://localhost` and
`http://[::1]` are accepted only for development. A relay bearer, when set, is
sent as `Authorization: Bearer …`; it is stored in the vault's sealed private
record, never in the public state.

### Arm

```json
{
  "v": 1,
  "type": "opensesame.deadman.arm",
  "state": {
    "v": 1,
    "id": "…",
    "tomb": "personal",
    "armedAt": "2026-10-20T12:00:00.000Z",
    "lastAuthenticatedAt": 1790000000000,
    "timeoutDays": 30,
    "packageDigest": "…",
    "itemCount": 3,
    "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
    "relayUrl": "https://relay.example/deadman",
    "sequence": 1,
    "signature": "…"
  },
  "webhookUrl": "https://agent.example/deadman"
}
```

The relay **must**:

1. verify `state.signature` over the canonical JSON of every state field
   except `signature`;
2. publish `state.publicKeyJwk`, the policy and the webhook destination to
   the trusted webhook (or store them for the release event);
3. store `state.lastAuthenticatedAt + timeoutDays` as the deadline, using its
   own clock and its own durable record;
4. reject a repeated arm id with different contents.

The public key is the only signing material that leaves the device. No item,
item name, item value, vault key or release key is in this request.

### Heartbeat

```json
{
  "v": 1,
  "type": "opensesame.deadman.heartbeat",
  "id": "…",
  "at": 1790000000000,
  "sequence": 2,
  "signature": "…"
}
```

The signature covers the canonical JSON of those five fields. The relay
verifies it with the public key from the arm record, accepts only a higher
`sequence` than the last one, and moves the deadline to `at + timeoutDays`.
A heartbeat may arrive late; the relay should still accept a signed, higher
sequence rather than treating a network retry as a new arm.

### Disarm

```json
{
  "v": 1,
  "type": "opensesame.deadman.disarm",
  "id": "…",
  "at": 1790000000000,
  "signature": "…"
}
```

The signature covers the canonical JSON of those five fields. The relay
deletes the deadline and tells the webhook the switch is off. The browser
does not remove its local state until this call succeeds.

## What the relay sends to the webhook

At least once before the deadline (recommended: at 80% of the window, and
again at 100%) the relay sends the trusted webhook a release event. A minimal
event:

```json
{
  "v": 1,
  "type": "opensesame.deadman.released",
  "id": "…",
  "deadline": 1792592000000,
  "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "armSignature": "…",
  "relayTime": 1792592001234
}
```

The webhook should reject an event whose `deadline` is in the future, whose
`id` is unknown, or whose relay signature is invalid. Sign the event with the
relay's own key (or a Standard Webhooks HMAC secret) and validate the
timestamp and event id to prevent replay. The `armSignature` proves the policy
came from the device that owned this switch; it does not prove death. The
webhook's job is to notify a person, not to release the package. Nobody but
the holder of the release key can open the package.

## Requirements and failure behaviour

- The relay must have a durable clock and store; a restart cannot forget a
  deadline or replay an old heartbeat.
- If the relay is unreachable, arming fails and the browser removes any partial
  local state. A failed heartbeat never blocks an unlock; the next unlock
  moves the local deadline and tries again.
- If the relay is lost, the local release screen still appears after the signed
  deadline, but no external notification is sent. The owner should be able to
  import the old arm record into a replacement relay or disarm locally with a
  documented recovery path.
- A relay that returns a non-2xx response makes the browser refuse the arm or
  disarm. Do not return 2xx for a request whose signature or sequence failed.
- The webhook must be HTTPS, must not follow redirects, and should enforce a
  small body limit. Use the `@opensesame/webhooks` Standard Webhooks helpers
  for HMAC delivery, or the ECDSA public key above.
- CORS: the relay must answer the browser's `OPTIONS` preflight and allow
  `content-type` and, when used, `authorization`. It should not allow
  credentials.

## What the relay must never receive

- a vault key, a recovery key, a passkey, or any item value;
- the release key (`osdm1_…`);
- a webhook secret in a URL (use the relay's own webhook secret);
- a request body above 64 KiB.

The package digest is a SHA-256 of the encrypted package. It lets a webhook
identify which release a notification refers to; it is not a decryption key.
