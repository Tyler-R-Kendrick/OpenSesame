# Claims

Generic claim sessions attach or transfer ownership/delegation. They are **not** OAuth device authorization.

## Token form

```
osc_clm_<public-id>.<base64url-32-byte-secret>
```

- Store only `HMAC-SHA-256(pepper, purpose || id || secret)`.
- Prefer fragment transport: `/claim#token=…` on the client app (Pages `identity.ceremonies`), then the token in the body of `POST /v1/claims/present` (an optional `userCode` may ride with it).
- User codes are separate, Crockford-style, hashed with a distinct purpose prefix.

## Lifecycle

`pending → presented → authenticated → reviewed → completed|denied`  
Any non-terminal → `revoked|expired`. Terminal states do not reopen. Presentation is the single-use transition: the target manifest is served exactly once, in the present response.

Completion needs the user code the claimed device displayed (checked against its digest, with a per-claim fence of five attempts before `too_many_attempts`) and, when a claim token is sent, that token's digest. It advances the claim through `authenticated` and `reviewed` as needed, requires the reviewer to name `acceptedItemIds` (no wildcard), and swaps the claim row by version (compare-and-swap, bounded retries) so exactly one completer wins. A replay by the same completer with the same decision is idempotent; a different decision on a completed claim is a conflict. After the swap, a provisional project named by the manifest becomes active (or expired, if its own TTL has lapsed), a named legacy agent is claimed by the completing principal, and a `claim.completed` audit event is appended.

## Partial claims

Accepted subsets must preserve dependency closure and include every required item; otherwise the claim refuses with `DEPENDENCY_CLOSURE`.

## Worker

Expired claims and provisional resources are cleaned by `@opensesame/identity-worker` with injected clocks in tests.
