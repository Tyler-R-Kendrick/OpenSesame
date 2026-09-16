# `@opensesame/wallet-x402`

Bounded **x402 exact-payment** profile for OpenSesame wallet spending
([ADR 0123](../../docs/adr/0123-wallet-spending-authority.md)).

This package is foundation-only:

- Pure profile types and `assess()` that refuse `upto`, Permit2, and implicit refill.
- Pure challenge matching that rejects wrong chain / token / recipient before any
  signing path exists.
- An adapter surface that stays **`evidenceStatus: "blocked"`** for
  `local_execution` until a local merchant/facilitator harness lands under
  `docs/evidence/wallet/`.
- **No mainnet, no real facilitator accounts, no production enablement.**

## What is enforced here vs residual risk

When the enforcement authority is `preallocated_purse`, assessment assumptions
**must** state the residual risk explicitly: the purse bound is
**allocation / balance exposure only**. It does **not** independently enforce
recipient or per-period / calendar rules against an unrestricted purse key
holder. Do not advertise those constraints as `enforced` under purse authority.

## CORS / payment headers (browser tests later)

x402 browser clients must exercise real CORS preflights against the merchant
origin. Do not disable browser web security, and do not treat a missing
`Access-Control-Expose-Headers` configuration as a successful checkout.

Pinned header names under the exact profile (case-insensitive on the wire):

| Direction | Header | Role |
|---|---|---|
| Response (402) | `PAYMENT-REQUIRED` | Challenge / payment requirements |
| Request (retry) | `PAYMENT-SIGNATURE` | Client payment authorization |
| Response | `PAYMENT-RESPONSE` | Settlement / acceptance evidence |

Notes for the future browser harness (QAB-06 / X402-02):

1. Preflight must allow the payment headers the client will send; a 402 that
   cannot expose `PAYMENT-REQUIRED` to script is a transport failure, not a
   paid success.
2. Do not forward signed authorizations across redirects or silent
   origin/scheme changes.
3. Bind method, normalized origin, path/query policy, and body commitment
   where the profile requires resource binding. Missing binding is reported as
   local/merchant-evidence, not on-chain enforcement.
4. Limit challenge size, alternative count, nesting, and billable attempts.
   Unbounded challenge alternatives are refused by `assess()`.

Browser CORS success/failure tests are intentionally **out of this package’s
unit suite**; they belong to the Pages / Playwright harness once a local
merchant exists.

## Scripts

```bash
pnpm --filter @opensesame/wallet-x402 test
pnpm --filter @opensesame/wallet-x402 typecheck
```
