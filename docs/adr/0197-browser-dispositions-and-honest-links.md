# ADR 0197 — A provider with no browser road says why, with evidence, and links what it names

- **Status:** Accepted
- **Date:** 2026-10-12
- **Builds on:** [ADR 0185](0185-native-browser-connectors.md) (every provider has a
  browser contract, a specialized route, or an explicit unavailable explanation),
  [ADR 0139](0139-one-definition-every-target.md) (one definition, a drift test per consumer),
  [ADR 0158](0158-settings-rows-act-or-are-absent.md) (a row acts, or it is not drawn)
- **Amends:** ADR 0185 §1 and §10, where "an explicit unavailable explanation" and
  "native companion configuration" were one generic sentence

## Context

ADR 0185 promised each provider a contract, a route, or an explanation. The
explanation was a catch-all. Walking the live catalog: **141 of 240 tiles** said
"Desktop app required", and a provider page said "this browser cannot run that
companion and has no supported browser driver for it". The same words covered
very different facts:

- Bitwarden: its vault-item API is the Vault Management API, which is the Bitwarden
  CLI's `bw serve` local server, and by Bitwarden's own documentation it "will block
  any request with an Origin header" by default. Its cloud Public API manages
  organizations (members, collections, groups, events), not vault items, and
  `identity.bitwarden.com` and `api.bitwarden.com` answer a preflight from this
  site without `Access-Control-Allow-Origin` while answering one from
  `https://vault.bitwarden.com` with it: an allow-list. "Needs a companion" was
  true, and told a person nothing.
- AWS Secrets Manager, Systems Manager and STS, Azure App Configuration, Google
  Cloud's Secret Manager and IAM Credentials API, and Let's Encrypt's ACME
  directory all answer this origin. "Desktop app required" was false: nothing
  was built, and the page did not say so.
- 52 model providers with a catalog endpoint were "Desktop app required". 20 of
  them answer `GET {base}/models` publicly with CORS, so that call cannot prove a
  key; 8 answer it without CORS headers; the rest were inconclusive.
- WebCrypto, the sealed local store, a FIDO2 key and this vault's own
  authenticator codes were "unavailable" although the vault already does them.

Separately, 23 catalog rows pointed `docs_url` at the page on fnox's site that
documents *fnox's* backend for a product, and the page labelled it "<Name>
documentation". Two of those pages (OpenBao, Vaultwarden) are 404s, as were the
links for OpenCode Zen and Plivo. A registry page on Vercel's site was offered as
the "Docs" of 31 services that publish none.

## Decision

1. **Every provider without a browser road gets a disposition**, one of a closed
   set, resolved once (`packages/app-core/src/lib/browser-disposition.ts`):
   `built-in`, `companion`, `refuses-browser`, `driver-pending`, `no-key-check`,
   `policy`, and the derived `no-contract`. Plan-based unavailable roads carry
   `needs-client-secret` and `no-public-contract`. A tile and a page read the same
   reason; "Desktop app required" is drawn only for a real companion.
2. **An authored row carries its evidence** in
   `spec/connectors/browser-dispositions.json`, and a test refuses a row without it:
   a `refuses-browser` row needs a 2xx probe from the audited origin that did not
   admit it; `driver-pending` needs a probe that did; `no-key-check` needs an
   unauthenticated `GET` that returned 200 and admitted the origin; `companion`,
   `built-in` and `policy` cite a page. A probe that disagrees with itself is
   inconclusive and produces no refusal. Errors and 5xx never produce a refusal
   (as in `browser-policy.json`). A control probe from a provider's own origin
   shows an allow-list rather than a broken probe.
3. **No authored row means no claim about the provider.** The derived statement
   says only what OpenSesame's catalog lacks: it names no HTTPS API a browser
   could call, or names one but defines no key check.
4. **A key is never proven by a public call.** A model list that answers without a
   key is `no-key-check`, not a verify contract. Saving a key OpenSesame has not
   proven would repeat the failure ADR 0185 exists to prevent.
5. **Evidence is re-runnable.** `pnpm audit:browser-dispositions` re-probes every
   recorded request from the audited origin, sends no credential, and exits 1 when
   an answer has moved (a refusal that now admits, or the reverse). It needs the
   network, so it is not in `pnpm verify`.
6. **A link says what its address is.** `docs_url` is the product's own
   documentation. fnox's pages stay as `provenance_url` and, where fnox is the only
   source (a plaintext file, a sealed file, an encrypted remote, a command, the OS
   keychain), as links labelled "fnox documentation". A bare marketing homepage is
   labelled "website"; a documentation host's front page stays documentation. A
   service that publishes no documentation link has no "Docs" key; the Vercel
   registry page is not offered in its place.
7. **The reasons are the page.** When no method can connect, the reasons open by
   default, and the one status glyph is named for the reason, not "has no
   supported browser connection method".

## Consequences

- Nothing here connects a provider that was not connected. What changes is that
  each page and tile now says what is true, backed by a probe or a page a person
  can open, and names the route that works today (Vault → Import for Bitwarden,
  1Password, Proton Pass, KeePass).
- **Bitwarden's live vault cannot be reached from a static origin.** Doing it
  needs something outside this origin's CORS regime: an extension holding host
  permissions, or a process the operator runs. That is a product decision (an
  extension bridge, an opt-in local relay, or self-hosted-only) and is not made
  here. ADR 0185 §8 and the matrix still say "no relay is provided".
- `driver-pending` is a ledger of real, browser-reachable work, and a test
  refuses a row for a provider that has a road. The first rows retired: **AWS
  Secrets Manager and Parameter Store** now connect from the browser
  (`native-aws*.ts`): the person's own IAM access key, signed with Signature
  Version 4 (the S3 signer, generalized and checked against Amazon's published
  test-suite vector), sent only to the endpoint AWS publishes for the region
  (compiled from the region, never typed). The preflight and the real response
  were both probed and carry `Access-Control-Allow-Origin`, and AWS's error body
  is readable. Verification is a real list call; one value is read on request,
  shown once and never kept. Still pending: AWS STS (a query-protocol XML
  service), Azure App Configuration, Google Cloud (blocked on a token source
  under enforced isolation) and ACME. Two model providers (`zai`, `minimax`)
  answer this origin and require a key, so an API-key contract can be authored
  for them.
- 25 `docs_url` values changed in `spec/connectors/catalog.json` (revision
  `2026-10-12.1`): 23 from fnox to the vendor, 2 dead links repaired. The age and
  Vaultwarden links are GitHub URLs that could not be fetched from the sandbox
  that audited them (bot-blocking), so they are unverified rather than known good.
- The probes were taken from `https://opensesame-labs.github.io`. They are not a
  statement about another origin; an operator on another origin should run the
  audit.
