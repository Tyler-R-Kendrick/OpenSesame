# ADR 0218 — A person's own OAuth application connects through the page, and through the bridge where the provider refuses web pages

- **Status:** Accepted
- **Date:** 2026-10-31
- **Builds on:** [ADR 0185](0185-native-browser-connectors.md) (a browser
  connector executes a compiled provider contract and proves access),
  [ADR 0199](0199-connector-bridge-extension.md) (an optional bridge extension
  carries requests to hosts a person allowed), [ADR 0149](0149-nothing-stored-in-the-clear.md)
  (nothing the client stores rests in the clear)
- **Amends:** ADR 0185 §3–§4, where a confidential client was "unavailable": a
  person's own registered application, with its client secret sealed on the
  device, is a supported road. ADR 0090 is untouched: the page stays static and
  has no backend, relay or server of ours.

## Context

Fifty providers authorize with a **confidential** client: the person
registers an application at the provider and receives a client ID and a client
secret, and the token endpoint wants both. ADR 0185 listed them as unavailable
because a static page "cannot hold a client secret". That was too strong. The
secret here is the *person's own*, for an application *they* registered; the
only question is where it rests and where it goes. It rests sealed in their
vault (the configured OAuth client already keeps it as a Token item, ADR 0149)
and goes only to the provider's token endpoint, as it would from any client the
person ran themselves.

What stopped these providers from working was not the secret but three smaller
things:

1. **Reach.** Many token, account and revocation endpoints answer a request
   from this origin without `Access-Control-Allow-Origin`, so a page that sends
   the request cannot read whether the exchange succeeded. The token exchange
   (`settleCredentialMutation`) also never went through the bridge at all.
2. **Contract.** The configured client ignored each provider's own contract:
   Atlassian's required `audience`, Notion's required `owner` and its version
   header, Slack's comma-separated scopes and `bot` tokens, Shopify's token
   header and tokenless-type answer, monday's GraphQL post. Without them the
   authorization request or the account check is refused.
3. **Honesty.** The form said nothing about the bridge for an OAuth
   application, and the support matrix said "Browser unavailable".

## Decision

1. **The person's own application, secret sealed on the device.** The existing
   "Bring Your Own OAuth App" form is the road (client ID, client secret,
   callback URL, permissions). The secret is a sealed Token item in the open
   vault, never in a URL, a log, a receipt or the clear; it is sent to the token
   endpoint the form names and to nothing else. Nothing is added to the page's
   architecture: no server, no relay of ours, no default pointing anywhere.
2. **The bridge carries what a page cannot read, and only that.**
   `spec/connectors/oauth-reach.json` records, from the audited origin and with
   fake credentials, whether a page can read each provider's token, account and
   revocation endpoint (`pnpm audit:oauth-reach`). An endpoint that answers
   with an allowing `Access-Control-Allow-Origin` (and, where the request has a
   custom header, a preflight that names it: `*` does not cover `Authorization`)
   is **direct**. One that does not is a host in the bridge's table for that
   provider (`oauth` hosts, ADR 0199's table, generated from the same spec).
   If a person never installs the bridge, nothing changes: the request is the
   page's own, as before.
3. **A tenant is a family, not a guess.** Okta, Auth0, Databricks, Shopify,
   Workday and BambooHR live at the person's own host. The table names a
   `*.suffix` family for each (`*.okta.com`, `*.myshopify.com`, …), and a host
   is carried only if it has at least one plain DNS label in front of the
   suffix, is under a family the table gives to *that provider*, and the person
   allowed that exact host in the extension. `okta.com`, `evilokta.com` and
   `acme.okta.com.evil.test` are not under `*.okta.com`. The page puts a tenant
   host the person typed in the bridge's popup (`need`); it allows nothing.
4. **Every credential-bearing request is carried alike.** The runtime sends a
   token exchange through the same decision a call gets: the operator's egress
   policy first, then the bridge if it holds the host. The lease is not part of
   the exchange's signal, so a late complete answer is still sealed and cleaned
   up (ADR 0185 §8).
5. **The provider's own contract, from its preset.** The authorization request
   adds the preset's required parameters (never one the flow already set), joins
   scopes with the preset's separator and omits an empty `scope`. A parameter this flow cannot honor is not sent: Slack's `user_scope` asks for a second user token the flow would discard. The token
   answer is read as the provider gives it: bearer, Slack's `bot`/`user`, and no
   type at all only for Shopify; `expires_in` as a number or a numeric string;
   scopes split on spaces, and on commas only where the provider's contract separates with them. The account check uses the preset's own
   method, headers, body and token header, but only at the address the preset
   names (a `{placeholder}` stands for what a person typed). No `resource`
   parameter (RFC 8707) is sent for a provider's own OAuth unless chosen: it is
   an MCP-era parameter their contracts do not name.
6. **The form says what to do.** For a provider whose endpoints the bridge
   carries, the OAuth method says which hosts, that the secret goes only there,
   and links the bridge's README. A provider whose endpoints a page can read
   says nothing.

## The same road for the providers that sign in with a key (Tailscale, Bitwarden)

Four providers the support matrix still called "companion" need nothing a
browser lacks. Tailscale's cloud API and Bitwarden's servers answer no web page
(probed, recorded in `browser-policy.json`), so the bridge carries them; the
cryptography Bitwarden's clients do is Web Crypto:

- **Tailscale** (`native-tailscale.ts`): an API access token, or an OAuth
  client exchanged for a token used once; proved by listing devices; approve and
  rename devices, list auth keys, create a one-time auth key shown once.
- **Bitwarden Secrets Manager** (`bitwarden-sm`, `native-bitwarden-sm.ts`): the
  access token's 16 bytes derive the key (HMAC-SHA256 then HKDF-Expand) that
  opens the login's payload; names and values are `EncString`s under the
  organization key, opened here.
- **Bitwarden and Vaultwarden vaults** (`native-bitwarden-vault.ts`): a personal
  API key logs in (no device email, no second step); the master password, which
  never leaves the device, derives the vault key (PBKDF2-SHA256 or Argon2id,
  bounded, then HKDF); items, including those with their own key, are opened
  here. `native-bitwarden-crypto.ts` is checked against Node's independent
  `crypto`.

## Not done, and said so

- Bitwarden's wire details (the Secrets Manager login's `Device-Type` header,
  the vault's device fields, `Key`/`key` spelling) follow its public clients and
  were not run against a live account. A vault key in a newer format than
  `EncString` type 2, organization items, and a vault over the bridge's 1 MiB
  answer are refused rather than guessed. A self-hosted Vaultwarden is reached
  directly: the bridge's closed table cannot name an address only its owner knows.
- No real provider account was used. The protocol is proven against a local
  HTTPS provider with real vault custody, a stand-in relay, and the dated
  probes; a provider that changes its CORS policy moves the probe, not the code.
- Reddit rejects a request without a unique `User-Agent`; a browser and the
  bridge cannot set one, so its answer is whatever Reddit gives a browser.
- The bridge's list of hosts a page asked for is kept in memory only (`storage.session`), since a tenant host can name a person's own organization.
- A bridged request already sent when the vault locks is still read when it lands, so a minted token can be sealed and cleaned up; nothing new starts.
- `monday`'s GraphQL account check is a POST the preset names; other providers'
  resources are read with GET.
- A provider with no preset (an MCP-only server) keeps the plain contract and a
  form whose endpoints a person types.

## Consequences

- Fifty providers have a registered-application road: 22 answer a web page
  directly, 22 need the bridge for their token or account endpoint, and 6 live
  at a tenant host the person names (revocation is recorded as evidence, but a
  connection never calls it, so it does not put a provider in the table).
- The bridge's table grows by OAuth hosts and tenant families; the extension's
  manifest and permissions are unchanged (optional, per host, on the person's
  click).
- `pnpm audit:oauth-reach` re-probes the evidence; a verdict that moves is
  reported and the table regenerates (`node packages/connector-bridge/scripts/emit-table.mjs`).
