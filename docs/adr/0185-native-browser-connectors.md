# ADR 0185 — Browser connectors execute compiled provider contracts

- **Status:** Accepted
- **Date:** 2026-10-09
- **Amends:** [ADR 0183](0183-self-hosted-connector-configuration.md)
- **Extends:** [ADR 0184](0184-browser-linear-authorization.md)
- **Uses:** [ADR 0130](0130-operator-controlled-capability-composition.md), [ADR 0149](0149-nothing-stored-in-the-clear.md)

## Context

A connector form must configure the selected provider and produce usable,
verified access. Saving a draft or dispatching an invented provider/operation
URL cannot establish that access. The self-hosted browser must also distinguish
public authorization from confidential OAuth, OS processes and provider-hosted
managed provisioning. This deployment has no connector relay.

## Decision

1. Cover all 225 merged provider identities (160 browse-catalog tiles) with a provider-specific
   browser contract, an existing specialized route, or an explicit unavailable
   explanation and supported alternative. Payment-policy refusals remain
   refused across the catalog and direct routes. A catalog badge is descriptive
   metadata, not an authorization or operation result.
2. Compile API-key verification contracts for 75 provider IDs, then apply a
   separate browser-only admission policy before collecting or sending credentials.
   Railway's three credential variants yield 77 credential profiles. Each
   profile fixes credential placement, required public/private fields and the
   real probe. Provider-managed key permissions remain provider-managed;
   resource access is not represented as an invented account or OAuth grant.
   Four product-policy entries and 27 audited-preflight provider IDs are unavailable.
   The remaining 44 IDs/profiles include five untested tenant/key URLs. The single
   authored `spec/connectors/browser-policy.json` pins exact variants/sites, tested
   origin/date, status and CORS headers. Observations do not imply universal
   provider prohibition; official server-only statements are identified separately.
3. Public REST authorization has nine profiles: GitLab, Microsoft, Microsoft
   Teams, Dropbox, Spotify, Google, OpenRouter, WorkOS and Resend. PKCE uses
   public application IDs; Google uses the official GIS token popup; WorkOS
   and Resend use HTTPS Client ID Metadata Documents (CIMD). Verify the actual
   provider account or resource before activating. Resend REST OAuth is unavailable
   because its compiled resource preflight refuses the audited browser origin;
   independent MCP and existing grant cleanup remain reachable. Microsoft verifies the
   signed identity token and binds its tenant/account to Microsoft Graph.
4. MCP selects the compiled resource and validates live protected-resource and
   authorization-server metadata against its exact binding. Public OAuth
   requires `none` token authentication, S256 and supported registration;
   dynamic registration (DCR) retains its actual client result before consent,
   while CIMD uses the deployment-owned public client document. Connection
   proof comes from real MCP initialization and tool discovery. Tool calls
   use the actual advertised tool name/schema and display bounded results.
   Both input and output validators preflight schema depth, nodes, finite local
   reference expansion, safe regular expressions and validation work. Unsafe or
   excessive schemas fail with an actionable browser-safety refusal before the
   synchronous interpreter runs; CSP and dependency policy stay intact.
   Confidential or incomplete metadata does not enable a browser form.
5. Serve `auth/native-connector.html` and, on HTTPS builds, the derived
   `auth/native-client.json` at the configured deployment base. The callback
   bridge namespaces consent parameters before app bootstrap. Seal a
   ten-minute pending transaction binding state, verifier, provider, actor,
   configuration, client, redirect and resource/issuer. Consume it once before
   token exchange; ambient identity sign-in does not consume it.
6. Private credentials, grants, pending state and recovery obligations share
   an atomic encrypted device record with public configuration and verified
   facts. Await durable commits before navigation or activation. Provider
   mutation intents precede credential mint/refresh/registration; returned
   credentials are retained before freshness or verification checks. A failed
   seal retains a bounded private retry candidate and blocks activation.
   If both storage and provider cleanup fail, provider-settings instructions
   explicitly describe the remaining obligation; no success is reported.
7. Cleanup journals exact grants and registration obligations, retains refresh
   rotations before further mutations, and uses guarded commits so concurrent
   edits cannot activate or forget another authority. Provider-supported
   revocation runs before deletion. User-supplied shared keys are forgotten
   locally. When no automatic revocation exists, describe provider access
   honestly; explicit provider-settings confirmation is human attestation,
   never machine proof or renewed access. Unresolved cleanup stays visible.
8. Optional capability activation owns egress and transport lifetimes. An old
   driver cannot adopt a new activation's lease. Only already-issued credential
   mutations may settle late for retention and compensation; ordinary stale
   requests cannot publish results. Request destinations are compiled provider
   contracts or separately validated Vault/OpenBao instance origins. Generic
   fabricated operation URLs and arbitrary secret-header maps fail closed.
9. Preserve strict vault COOP/COEP. Google GIS popup authorization is unavailable
   under enforced isolation; it does not weaken those headers. Its official
   SDK and frame are admitted only in a non-isolated build whose approved
   capability and external-network policy permit them. Provider CORS, CSP and
   application registration still determine whether a supported request runs.
10. Preserve Git backup, GitHub, Linear, S3 and vault-key protection routes.
    Native companion configuration and supported file import are separate
    from browser execution. No saved auth key pretends to enroll tailscaled,
    execute an OS keychain command or provision a wallet.

## Consequences

Users can verify provider access, authorize supported public clients, repeat
real provider reads, discover/call MCP tools, and recover or remove saved
connections from a static browser deployment. API-key verification exposes
bounded resource summaries rather than offering unimplemented business APIs.
Only Linear's specialized route registers webhooks; other catalog trigger
metadata does not create a receiver or subscription.

The [operator guide](../operators/native-browser-connectors.md),
[225-provider support matrix](../operators/native-connector-support.md) and
[API-key contracts](../operators/native-api-key-contracts.md) identify the
actual methods and constraints. Protocol tests and production-browser journeys
use disclosed synthetic provider authorities, including encrypted cold reload
and PIN unlock. They do not establish live account consent or universal CORS
support; operators verify their own provider registrations and origins.
