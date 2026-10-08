# `@opensesame/wallet-x402`

Bounded **x402 exact-payment** profile for OpenSesame wallet spending
([ADR 0123](../../docs/adr/0123-wallet-spending-authority.md)).

This package is a bounded profile, not a production payment path:

- Pure profile types and `assessExactPayment()` (also exported as
  `assessX402Adapter`) that refuse `upto`, Permit2, allowance paths and
  implicit refill. Every constraint is reported `approval_only` and the
  assessment's `evidenceStatus` stays `blocked`.
- Pure challenge matching (`matchChallenge`) that rejects wrong chain / token /
  recipient before any signing path.
- A local-only prepare / execute path (`prepareX402Payment`,
  `executeX402Payment`, `reconcileX402Payment`; `settleExactPayment` in
  `exact-settle.ts`) that signs and settles an Exact EIP-3009 payment through
  `@x402/core`, `@x402/evm` and `viem`. It needs a `LocalExactRuntime` the
  caller passes in (Pages never does) and refuses any chain but 31337 or any RPC
  but `http://127.0.0.1`. A prepared ref is single-use, expires after 60 s, and
  at most 1,024 may wait. `reconcileX402Payment` answers `unknown`.
  `describeX402Adapter()` reports `evidenceStatus: "blocked"` unless it is told
  `localExecutionVerified`, and `productionEnabled` is always `false`.
- **No mainnet** (`MAINNET_CHAIN_IDS` are refused), **no real facilitator
  accounts, no production enablement.**

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
   Unbounded challenge alternatives are refused by `assessExactPayment()`.

The pure gate for the CORS and redirect rules is `assessExactPaymentCors`
(`cors.ts`, WAL-E12): it refuses a missing, wildcard, `null` or mismatched
`Access-Control-Allow-Origin`, an `Access-Control-Expose-Headers` that lacks
`payment-required` or `payment-signature`, and a signed authorization forwarded
across a redirect. Real-browser CORS success/failure tests are intentionally
**out of this package’s unit suite**; they belong to the Pages / Playwright
harness once a local merchant exists.

## Scripts

```bash
pnpm --filter @opensesame/wallet-x402 test
pnpm --filter @opensesame/wallet-x402 typecheck
```
