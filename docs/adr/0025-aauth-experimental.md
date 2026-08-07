# ADR 0025 — AAuth experimental adapter

## Status
Accepted

## Context
AAuth (draft-10) proposes Person/Agent/Mission semantics that overlap OpenSesame principals, actors, and task governance but remain unstable.

## Decision
Provide `opensesame-protocol-aauth` behind feature flag `experimental-aauth` (disabled by default). Map Person→Principal, Agent→Actor+Instance, Mission→GovernanceContext with exact-byte mission digest; token identity as `(issuer, jti)` `ProtocolTokenRef`. No public HTTP endpoints in this slice.

## Consequences
Production builds omit the adapter unless explicitly enabled. Draft breakage is isolated. Docs mark the profile `aauth-draft-10-experimental` as experimental maturity.
