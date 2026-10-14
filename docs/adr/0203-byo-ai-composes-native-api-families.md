# ADR 0203: BYO AI and native presets share executable API families

Date: 2026-10-14

Status: Accepted

## Context

Integrations mixed provider configuration with AI feature choices and exposed
a Local storage category whose cards did not describe the PWA's vault. A
provider-specific form also made custom endpoints inconsistent with native
connections. Configured inference must use the saved connection, including
its actual endpoint, request protocol and owning vault credential.

## Decision

Remove the Local storage integration group and navigation contribution. Keep
the existing encrypted local vault and its SecretBackend adapter. Register
Voice and Inference through the normal Features AI contribution rather than
drawing special feature controls above the integration tiles.

BYO AI and compatible partner presets compose one typed configuration and
one form. Catalog metadata supplies partner defaults; BYO exposes OpenAI Chat
Completions, OpenAI Responses, Anthropic Messages and Gemini GenerateContent.
Each family implements its actual URL, authentication headers, request body,
JSON result and SSE terminal events. A provider-specific REST row is not
silently promoted to a compatible inference protocol.

Test and Save perform bounded real inference through approved capability
egress. Requests retain the configured mount path, omit cookies and refuse
redirects. Browser CORS and deployment policy still apply. No application
backend, extension or spawned model process is required. A failed or malformed
probe cannot become a verified connection.

Save the API key as a standalone Token CredentialItem in the owning encrypted
vault using the shared credential custody implementation from ADR 0202.
Connection metadata retains its target-bound reference and verified digest.
Runtime admission checks the actual current item, vault session and record
revision. Lock, replacement, token edits and capability disposal invalidate
in-flight results. The saved connection is selectable by stable connection
identity in Features and executes through the existing hosted support path.

Preserve the delegated model broker's closed protocol and endpoint contract.
Only the catalog's exact canonical Chat Completions, Anthropic and Gemini
contracts may back existing application model keys. Both admission and
execution reject BYO, custom endpoints and Responses. Reconfiguration cannot
redirect an older delegated key to a different host or protocol. Direct
explicit inference remains available for those configurations.

## Consequences and verification

Future compatible partners derive defaults from the catalog rather than
adding duplicate forms. Protocol extensions require request/result and stream
tests, not another label on an OpenAI-shaped call. The configuration checks
include real vault credential custody, failed probes, token tampering,
session races and broker budget accounting. Browser evidence must exercise
actual HTTP preflights and protocol-specific JSON/SSE responses, plus the
saved selection through the app's support inference path.

The dev-only React type pins are aligned across root, Pages and example
applications so a fresh frozen install resolves a single compatible React
type graph. This does not add a runtime dependency.

Operator instructions: [AI connections](../operators/ai-connections.md).
