# Claims

Generic claim sessions attach or transfer ownership/delegation. They are **not** OAuth device authorization.

## Token form

```
osc_clm_<public-id>.<base64url-32-byte-secret>
```

- Store only `HMAC-SHA-256(pepper, purpose || id || secret)`.
- Prefer fragment transport: `/claim#token=…` then POST body (console).
- User codes are separate, Crockford-style, hashed with a distinct purpose prefix.

## Lifecycle

`pending → presented → authenticated → reviewed → completed|denied`  
Any non-terminal → `revoked|expired`. Terminal states do not reopen.

Completion locks the claim row, validates manifest digests/versions, applies ownership, re-evaluates provisional grants, writes audit + outbox atomically, and is idempotent under matching idempotency keys.

## Partial claims

Accepted subsets must preserve dependency closure; otherwise typed conflict.

## Worker

Expired claims and provisional resources are cleaned by `@opensesame/worker` with injected clocks in tests.
