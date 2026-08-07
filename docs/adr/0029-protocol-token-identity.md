# ADR 0029 — Protocol token identity

## Status
Accepted

## Context
Replay detection and audit correlation require stable token references without storing raw bearer material.

## Decision
Protocol tokens are identified by profile-specific refs: opaque digest for internal task credentials; `(issuer, jti)` tuple for JWT-family profiles (including experimental AAuth). Raw token strings are not persisted in authoritative stores after validation.

## Consequences
Replay caches key on `(issuer, jti)` or token hash. Audit events reference `ProtocolTokenRef` or credential digest. Introspection results map to refs, not secrets.
