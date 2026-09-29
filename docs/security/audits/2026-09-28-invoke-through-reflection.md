# Invoke-through returned a reflected credential to its caller

## Scope

- `crates/invoke-through`: `Invoker::execute` and its response path.
- Found while designing [ADR 0150](../../adr/0150-surrogate-credentials-at-the-last-hop.md).

## Invariant

Invoke-through's invariant (ADR 0048 D7) is that the caller "sees the upstream
response and a structured receipt; nothing else".

## Finding

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | `execute` returned the upstream body and the allowlisted response headers verbatim. An upstream on the egress allowlist that echoes the presented `Authorization` handed the caller the credential the broker had just placed. Examples: a debug or echo route, an error message quoting the rejected token. The fence stopped the caller *sending* the credential anywhere. It did not stop the allowed host *returning* it. | `scrub::Needles` runs over the body and every returned header before the caller sees them. It replaces the following with `[redacted:credential]`: the raw token; its percent-encoding; its base64 body, standard and URL-safe, at all three byte alignments (alignment 2 is `Basic base64(user:token)`). `ReceiptMeta.credential_reflected` records the event. |

Severity is Medium, not High. The only host that can reflect the credential is
one already on the exact-host allowlist, which today is GitHub's API. GitHub's
API is not known to echo `Authorization`. The finding is still a broken
invariant rather than a theoretical one: the allowlist is meant to grow, and
error bodies that quote a token are common.

## Tests

- `invoke_tests.rs::a_reflected_credential_never_reaches_the_caller` failed
  before the fix. It covers raw, `Basic`-aligned base64, aligned base64 and a
  reflected header.
- `an_unreflecting_response_is_returned_unchanged` checks that a response with
  nothing to scrub comes back byte-identical and without the receipt flag.
- `scrub.rs` unit tests cover every alignment in both alphabets,
  percent-encoding, untouched bytes, an empty token and header text.

## Not fixed

A transform of the credential is not the credential, and it is not matched.
Examples: a hash, a reversal, an encryption. The scrub removes the credential,
not everything derived from it.
