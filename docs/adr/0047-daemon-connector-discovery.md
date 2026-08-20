# ADR 0047 — Daemon connector discovery with consented promotion

Status: Proposed
Date: 2026-08-19
Supplemented by ADR 0048 (capability-moded discovery) and ADR 0049
(derived short-lived materialization).

## Context

A developer's machine is already full of authorized services. `GITHUB_TOKEN`
in the shell profile, `STRIPE_SECRET_KEY` in a project `.env`,
`~/.aws/credentials`, `~/.vault-token`, a `.mcp.json` naming six MCP
servers. Every one of them is a connector OpenSesame could broker, and
today the user has to find and paste each one by hand.

The detection logic to find them already exists — it is just running in
the wrong process. `detect_connection_configuration_with(provider,
read_env, read_file)` (`crates/connection-broker/src/config.rs:290`) is
closure-injected and host-agnostic, backed by a curated alias table for
forty-odd providers (`:497-557`: `STRIPE_SECRET_KEY`, `HF_TOKEN`,
`DOPPLER_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`, the AWS and Azure and GCP
families) and dotfile readers for `~/.vault-token`, `~/.bao-token`,
`~/.aws/credentials`, and gcloud application-default credentials
(`:393-472`). The gateway calls it through
`POST /api/v1/connections/discover` → `auto_configure_connections`
(`lib.rs:324`), which scans the **gateway's** environment and imports
whatever it finds silently, returning a count.

Two things are wrong with that for this use case. The gateway's
environment is a server's environment, not the developer's machine; and
silent import is the wrong consent model for credentials a person did not
ask us to take. The daemon (`apps/daemon`, loopback `:18790`) is the
process that actually lives on the user's machine.

The security context is unusually sharp here. The daemon's own history
includes `docs/security/audit-2026-08-08-legacy-credential-agent.md`,
where an unauthenticated local route that enumerated sessions and minted
capabilities was rated Critical, with the finding stated as: "Loopback is
not a boundary in this threat model — it is why the daemon has an operator
token and a UDS-only mode." A route that enumerates *which credentials
exist on this machine* is a strictly more valuable target than the one
that finding was about.

## Decision

1. **The daemon discovers; it does not import.** A new operator-gated
   `POST /v1/discover` scans the daemon's own environment, the user's home
   directory dotfiles, and configured MCP servers, and returns an
   **offer**: a list of providers that appear to be configured on this
   machine. Promotion into a broker connection is a separate, explicit,
   per-provider action. The gateway's silent `auto_configure_connections`
   stays where it is and is not extended.
2. **Discovery never discloses secret material.** The response carries the
   provider id, the *source* that matched (`env:GITHUB_TOKEN`,
   `file:~/.aws/credentials`, `mcp:github`), and presence. It carries no
   values, **no masked prefixes, and no lengths** — a prefix or a length
   narrows an offline guess, and "it starts with `sk_live_`" is itself a
   disclosure. There is no "test this credential" action in v1, because a
   test is an oracle.
3. **MCP configuration files are read for names only.** `.mcp.json`,
   `~/.cursor/mcp.json`, `claude_desktop_config.json` and their siblings
   routinely embed raw API keys inside each server's `env` block. The
   scanner reads server names and env *key* names and never reads, stores,
   or echoes a value from those files. Parsing is size-capped like every
   other credential-adjacent read (`MAX_CREDENTIAL_BYTES`).
4. **Operator-gated, read-only, and rate-limited.** `/v1/discover` sits
   behind `require_operator` like every other mutating daemon route, even
   though it mutates nothing, because the threat is disclosure rather than
   modification. It performs no network calls and writes no state.
5. **Promotion flows through the existing credential path.** A promoted
   provider is created and credentialed via the gateway
   (`POST /api/v1/connections/{id}/credential`), which already seals,
   validates, and audits. Note the real constraint:
   `accepts_pasted_access_token` is `github | gitlab` only
   (`crates/connection-broker/src/lib.rs:1763`), so most discovered
   credentials take the `configuration_set` path rather than the
   pasted-token fast path. **This slice ships the offer only**; the
   end-to-end promotion handshake is design-only.
6. **The detection logic moves to a crate with no credential machinery in
   it.** `connection-broker` carries sqlx, oauth2, jsonwebtoken,
   chacha20poly1305, reqwest and the task bus; linking that into the
   daemon would graft the entire credential-exchange and database surface
   onto a loopback agent whose whole threat model is "must not become a
   credential oracle." Detection needs none of it, so it is extracted into
   `crates/connection-detect` (serde and std only), which
   `connection-broker` re-exports so existing call sites and tests are
   unchanged.

## Consequences

- The daemon gains its first knowledge of providers, which is a real
  increase in what a compromised operator token is worth: it now reveals
  which services this machine is configured for. That is accepted, and
  bounded by decision 2 — the token already grants capability minting and
  request forwarding, so provider *metadata* is strictly less than what an
  attacker with that token already holds. It is called out here rather
  than buried, and the value-blind response is enforced by a property test
  that plants secrets in the environment and asserts they never appear in
  any response body.
- Discovery is best-effort and will produce false positives (an env var
  named like a provider's that holds something else) and false negatives
  (credentials in a password manager, a keychain, or a shell function).
  The offer wording must therefore be "these look configured" rather than
  "these are connected," and promotion always confirms per provider.
- The extraction is behavior-preserving by construction: the existing
  `connection-broker` detection tests move with the code and are the
  oracle for the refactor.
- Nothing here changes the gateway's discovery endpoint, the sealing key
  requirement, or ADR 0032 §2's ownership fence — a promoted connection is
  owned by the caller that promoted it, like every other connection.
