# ADR 0022 — Proof key custody

## Status
Accepted

## Context
DPoP signing keys must not become a generic signing oracle for arbitrary payloads.

## Decision
Proof keys sign only `AuthorizedProofRequest` bindings that include purpose, task run, state digest, and HTTP method/URI (plus optional intent digest). `KeyCustodyProvider::sign_dpop` consumes a one-time authorization digest; requests that do not match are rejected (`SigningOracleMismatch`).

## Consequences
Credential-agent and local software custody implement the trait. Agents never hold raw signing keys for unrestricted JWT minting. Validation lives in `opensesame-proof`.
