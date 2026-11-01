# ADR 0198 — Providers that connect with a person's own key share one driver core

- **Status:** Accepted
- **Date:** 2026-10-12
- **Builds on:** [ADR 0185](0185-native-browser-connectors.md) (a provider connects
  from the browser only through a compiled contract that proves access),
  [ADR 0197](0197-browser-dispositions-and-honest-links.md) (a provider with no
  road says why, with evidence; `driver-pending` is a ledger of real work),
  [ADR 0149](0149-nothing-stored-in-the-clear.md) (nothing the client stores rests in the clear)
- **Retires:** every `driver-pending` row ADR 0197 recorded

## Context

ADR 0197 recorded seven providers whose servers answer this origin and for which
nothing had been built: AWS STS, Azure App Configuration, Google Cloud Secret
Manager, Google IAM Credentials, Let's Encrypt, MiniMax and Z.AI. It also found
20 model providers whose only catalogued call is public, so it cannot prove a
key. A catalog row that names an API and a docs page is a promise; leaving it as
"not built yet" breaks it as surely as the old "Desktop app required".

The one driver that existed (AWS Secrets Manager and Parameter Store) carried
its own copy of every flow around the call that matters: prove the key before
anything is saved, bind the saved connection to exactly what was proved,
re-prove on request, read on request and show once, forget locally. Writing five
more copies would have put five more chances in the repository to save a key
that was never checked.

## Decision

1. **A key-driven family is a `NativeKeySpec`; the flows are written once.**
   `native-key-types.ts` is the whole contract: the family's name and id prefix,
   which public parameters and private credentials it keeps, its form
   (`ui`), how a form is validated (`parse`), what binds a connection
   (`fingerprint`), the one real call that proves the key (`prove`), the reads a
   person may ask for (`operations`, each with exactly the input keys it takes),
   and which refusals end a proof (`refused`). `createNativeKeyFlows` supplies
   configure, verify, invoke and cleanup. Families register in
   `NATIVE_KEY_DRIVERS`; the connection form, the runtime and the cleanup find a
   provider there and nowhere else, so a provider with a driver has no
   disposition (a test enforces it).
2. **The proof comes first and binds what is saved.** Nothing is written until
   `prove` succeeds. The saved grant carries a SHA-256 of the private
   credentials in classification order; a connection whose sealed key no longer
   matches the one that was proved is not "connected", and a key the provider
   refuses stops looking verified without losing its other settings. A proof may
   hand the connection something it must keep (an account a provider just
   opened, a key generated here): `proof.update`.
3. **A read is asked for, shown once, and never kept.** Secret values, issued
   credentials and generated keys are returned as `secretValue` and are in no
   record. An operation offers exactly the input keys it lists; any other is
   refused before a request. Every request is `credentials: "omit"`,
   `redirect: "error"`, bounded in size and time, and a provider's own words
   (an error `detail`, an XML message) are never repeated: a failure is a class.
4. **The families.**
   - *AWS STS*: the S3/Secrets Manager SigV4 signer, `GetCallerIdentity` as the
     proof, `AssumeRole` and `GetSessionToken` on request. The XML reader is
     bounded and refuses `DOCTYPE` and entities.
   - *Azure App Configuration*: the store name is compiled to
     `https://{store}.azconfig.io`, never typed as a URL; HMAC-SHA256 request
     signing; the independent oracle in the tests is Node's own HMAC.
   - *Google Cloud Secret Manager and IAM Credentials*: the person's service
     account key signs an RS256 JWT with WebCrypto; the token endpoint is fixed
     (the key file's `token_uri` is ignored); the access token lives for one call.
   - *Let's Encrypt (ACME, RFC 8555)*: the account key is generated in the page
     (P-256), sealed, and never shown. Registration is `newAccount` with
     `termsOfServiceAgreed`, which creates or finds the account, so verification
     is idempotent. Only DNS-01 is offered, because a page cannot answer an HTTP
     request: opening an order returns the TXT records to publish (the value is
     `base64url(SHA-256(token "." thumbprint))`, checked against an independent
     computation); finishing it answers the challenges, finalizes with a PKCS#10
     request signed in the page, and downloads the chain. The certificate's
     private key is generated per order, shown once, and kept nowhere. Every
     address the CA names must be its own host under `/acme/`; the order address
     a person pastes must also have the shape the CA gives orders. Only a refused
     *account key* ends the proof: a name the CA will not certify does not.
   - *Model providers*: 23 presets (the 19 `no-key-check` providers whose
     authenticated routes admit this origin, Z.AI, MiniMax, Baseten and Poolside) use the
     existing API-key contract. A call that can bill (`POST …/chat/completions`)
     is allowed only where no read exists and the preset's instructions say it
     "may bill"; `POST …/check_api_key` is NEAR AI's documented key check. Edenai's
     authenticated routes do not admit the origin and it is recorded as
     `refuses-browser` with the probes that show it.
5. **Evidence grows two stages.** A probe may be an `authenticated-invalid-key`
   (a fake key; the refusal must carry an allow-origin so a page can read it) or
   an `unauthenticated-post`. The `refuses-browser` rule accepts a 2xx the origin
   was not admitted to, or a 401/403 to an authenticated request that was not.
6. **`driver-pending` stays in the type but no row may use it.** A provider whose
   API a browser can reach gets its driver in the same change that finds it; the
   test that lists remaining rows now asserts the list is empty.

## Consequences

- AWS STS, Azure App Configuration, Google Cloud Secret Manager, Google IAM
  Credentials, Let's Encrypt and 23 model providers connect from the browser
  with a proof; 30 `driver-pending`/`no-key-check` rows left the ledger.
- The Pages form is drawn from `NativeKeyUi`; a family adds no component.
- A driver nobody can reach is not a connection. AWS STS, Google Cloud IAM Credentials
  and Let's Encrypt had a catalog row and no tile, so the Connections page answered
  "Connector not found" for them; they are now bundled
  (`CLOUD_CREDENTIAL_PROVIDER_IDS`, `CERTIFICATE_PROVIDER_IDS` in
  `embedded-catalog-data.ts`) and drawn where their families live, Settings ›
  Integrations › Cloud secret storage and › Certificate authority. The capture
  that found this is in [historical evidence](https://github.com/OpenSesame-Labs/OpenSesame/tree/fd554446241e32962e82763ddb772f9420096279/docs/evidence/2026-10-12-key-driven-providers/).
- ACME needs the person to publish DNS records and wait: Finish tells the person
  so, in its own words, when the CA could not find them.
- Verification of Let's Encrypt against the real staging CA was run during
  development (account creation, idempotent re-registration, a two-name order
  with a wildcard); completing an order needs control of a domain's DNS, so the
  full path is exercised against a fake CA that enforces RFC 8555's rules
  (signature under the account key, one-time nonce, signed URL, signed CSR).
- Providers whose authenticated routes refuse this origin, and those with no HTTPS
  API a page can call, are not changed here. They are the subject of the next ADR.
