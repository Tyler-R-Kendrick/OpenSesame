# ADR 0099: Explicit short-lived local agent launch capabilities

Status: accepted

## Context

An operator credential inherited by an MCP process gives an agent human
administrative authority. Same UID and a Unix socket attest local transport
identity, not the intent to grant that authority.

## Decision

The native `local-authority launch` ceremony selects the principal,
organization, audience, executable and capability list and requires terminal
approval. It obtains a one-use launch handle from the Host. The child receives
an explicitly restricted environment, not the parent's operator credential.

Unix clients exchange the launch handle through the daemon UDS path, which
checks peer credentials and requires the handle as well. The daemon forwards
only that bounded exchange to the Host. Windows uses the explicit handle
exchange against the configured Host rather than claiming a named-pipe
implementation exists. Host exchange refuses browser Origin requests.

The durable launch/grant binds principal, organization, exact Host resource,
client UUID, one of the MCP host/client audiences and a static operation
ceiling. Launch and issued capability expire within five minutes. A launch
handle is consumed once. The client removes it from its own environment after
acquisition, caches the resulting grant only in process memory and requires a
new approved launch after expiry or failed acquisition.

The reviewed ceiling includes task read/create/invoke/terminate and encrypted
sync read/write. Server middleware checks exact route, audience, client and
scope before dispatch. Neither changing an audience header nor calling a
different route broadens the stored grant. Agents cannot administer human
credentials, approve pairing/device claims, reveal key material or consume
browser-control elevation. Unsafe human/operator MCP tools are not a supported
agent catalog; absence of a tool is supplemented by server enforcement.

## Compatibility and recovery

MCP configurations must stop forwarding operator/session credentials. Launch
the selected executable through the native ceremony with only its required
capabilities. A process restart needs a new one-use handle; there is no silent
operator fallback. Explicit revocation removes active authority and pending
launches for the selected principal/organization/client.

Task invocation still passes through ConnectionRef, task access policy and
receipts. A scoped transport grant is not permission to reveal underlying
credentials or bypass domain policy.

## Evidence and residual risk

The initial local capability is a short-lived bearer, not sender-constrained
DPoP. A same-user process that steals the handle before exchange or the active
bearer can race or impersonate within its narrow ceiling and lifetime.
Client UUID/audience binding is not cryptographic process attestation. UDS
reduces transport exposure but does not eliminate same-user malware.

Focused exchange, audience, replay, route-policy, environment-minimization and
MCP catalog tests provide regression coverage. This ADR does not claim every
platform has been dynamically exercised or the complete security scan passed.
