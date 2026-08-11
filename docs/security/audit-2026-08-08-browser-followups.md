# Audit 2026-08-08 — four browser-surface follow-ups

The remaining "not fixed here" items from the Pages, console and sealed-store
ticks.

## 1. Cookie-authenticated mutations had no CSRF story (tick 71)

The Pages outbox sent `credentials: "include"` to the Identity API, and the
control plane accepted its session cookie as authentication for any request. A
cookie travels because the browser decided to send it, not because the page meant
to send it, so on its own it says nothing about who asked.

Two changes, in the order that matters:

- **The service is the fence.** A mutation authenticated by cookie must also carry
  an `Origin` this deployment listed in `OPENSESAME_CORS_ORIGINS`, or the service's
  own origin. Otherwise the cookie does not authenticate and the request is 401. A
  bearer token is unaffected: a caller that had to attach a token was not tricked
  into attaching it. Reads are untouched — a forged read is not a forged write.
- **The page stops asking for what it cannot use.** Pages sends the ambient session
  only to its own origin. The cookie is `SameSite=Lax`, so a browser was already
  dropping it from a cross-site POST; asking anyway only obscured that the call was
  relying on credentials it could not see.

`SameSite=Lax` remains set. It is a browser default and does not separate sibling
origins on one site, which is why the origin check exists as well.

## 2. The pre-PBKDF2 unlock record was accepted forever (tick 72)

An unsalted single-round SHA-256 record was upgraded on every successful unlock,
but accepted indefinitely. `LEGACY_PIN_RETIRED_AFTER_MS` (2027-01-01) ends it:
past that date the record is refused rather than upgraded, and a person sets a new
PIN. Nothing is lost by refusing — this record gates the session, it does not key
the vault — and every unlock before then rewrites it at current cost, so the only
people left on it are people who have not unlocked in months.

## 3. Nothing bound a sealed store to its device (tick 73)

Validation stopped a malformed file but not a well-formed one copied from another
profile: `apps/pwa` and Pages read `cursor.device_id` out of the store and adopt
it, so a file copy handed over an identity and an epoch. A store's cursor must now
name the device it is stored under — `persistSealedStore` refuses to write another
device's store, and `loadSealedStore` reads a mismatch as absent.

## 4. The console's operator token could be baked into a bundle (tick 71)

`VITE_*` variables are inlined into shipped JavaScript, so a production build with
`VITE_OPENSESAME_OPERATOR_TOKEN` set published a machine-local shared secret to
everyone who loaded the page. Keeping it out was a deployment convention; the
production build now refuses outright. The existing runtime fence still applies:
the token is only ever sent to a loopback gateway.

## Not fixed here

- Client-side lockout state remains advisory. Anything that can write our storage
  can reset the counter, and nothing in a browser prevents that; the iteration
  floor is what costs an attacker something.
- A sealed store is still sealed by whatever sealed it. `sealDevOnly` remains an
  XOR fenced to dev/test and the real AEAD lives in the Rust wasm build.

## Verification

- `apps/pages` 18 tests, `packages/client-core` 7, `apps/control-plane` 34 (1 new)
- `pnpm -r typecheck`, full workspace tests green
- `pnpm --filter @opensesame/console build` refuses with the token set, builds without it
