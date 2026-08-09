# Audit 2026-08-08 — an issuer could aim our requests at our own network

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, gitleaks, semgrep, ast-grep — all clean. This is a
fresh-eyes review of the JWKS discovery added in
`audit-2026-08-08-resource-server-sdk.md`, four ticks ago, which turned out to be
one instance of a pattern in three packages.

## Finding

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium–High | Endpoints taken from a remote issuer's discovery document were checked with `assertSecureUrl`, which permits cleartext on loopback. That is the right affordance for a URL an operator configured and the wrong one for a URL a remote party supplies: any issuer could name `http://127.0.0.1:9200/jwks`, `https://169.254.169.254/…`, or a private-range address, and the process would make that request. Affected `jwks_uri` (`sdk-server`), `authorization_endpoint` / `token_endpoint` / `device_authorization_endpoint` (`sdk-cli`), and the same three in `sdk-browser`. | New `assertDiscoveredUrl` / `assertDiscoveredJwksUri`: a discovered endpoint may name private space only when the issuer is itself private. |

Reproduced before the fix: with `issuer: "https://remote.example"` and a discovery
document naming `http://127.0.0.1:9200/jwks`, `discoverJwksUri` resolved without
complaint and the verifier went on to fetch keys from it.

What makes this worth more than a lint: in `sdk-cli` the discovered
`token_endpoint` is where a device code and a client assertion get POSTed, and in
`sdk-browser` the discovered `authorization_endpoint` is where the user is
redirected. A remote issuer choosing those targets is choosing where a credential
goes, not merely causing a wasted request.

## The rule

A discovered endpoint may name loopback, `10/8`, `172.16/12`, `192.168/16`,
`169.254/16` (link-local, which is where cloud metadata lives), `fc00::/7`,
`fe80::/10`, `0.0.0.0`, or a `.internal` / `.local` name **only when the configured
issuer is itself private**. That is the local development case, where both ends are
on this machine and nothing is being crossed. A remote issuer naming a public host
that is not its own origin is still allowed: plenty of real issuers publish keys on
a separate hostname, and refusing that would break them for no security gain.

An explicitly configured `jwksUri` keeps the old rule. It is the operator's own
choice, and loopback is the point of it in development.

## Not fixed here

- The check is on the hostname as written. A public DNS name that resolves to
  `127.0.0.1` or into a private range still passes, and nothing here can see that —
  a resolving fence belongs in the fetch layer, not in a URL assertion.
- The discovery response body is read with `res.json()` and has no size bound, so a
  hostile issuer can still make a client read a large document.
- `sdk-server`, `sdk-cli` and `sdk-browser` each carry their own copy of these host
  predicates because they target different runtimes. Three copies is three chances
  to fix only two of them next time.

## Verification

- `packages/sdk-server` — 16 passed (2 new: nine private targets refused across both
  schemes; a public cross-host key set and a loopback-issuer pair still accepted)
- `packages/sdk-cli` — 16 passed (2 new: a remote issuer naming a loopback
  `token_endpoint` refused; a loopback issuer's loopback endpoints untouched)
- `packages/sdk-browser` — 11 passed; `pnpm -r typecheck` and the full workspace
  suite green
- cve-lite, osv-scanner, gitleaks, semgrep, ast-grep — clean
