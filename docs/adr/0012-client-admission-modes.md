# ADR 0012 — Client admission modes

## Status
Accepted

## Decision
Four admission modes: pre-registered (production default), origin-profile (Shoo-inspired convenience, flag-gated), DCR (flag-gated), CIMD draft (flag-gated + SafeMetadataFetcher SSRF controls). Origin clients are not claimed as an IETF standard.

## Consequences
Mandatory demos use pre-registered + mock IdP. CIMD/DCR remain off unless explicitly enabled.
