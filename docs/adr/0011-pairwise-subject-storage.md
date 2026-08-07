# ADR 0011 — Pairwise subject storage

## Status
Accepted

## Decision
Persist random opaque pairwise subjects per `(principalId, sectorIdentifier)` rather than irreversible HMAC of principal+sector with a global secret. Sector resolution is explicit per client admission mode.

## Consequences
Issuer signing-key rotation does not change pairwise subjects. Tests prove stability within a sector and difference across sectors; canonical principal IDs never appear as `sub`.
