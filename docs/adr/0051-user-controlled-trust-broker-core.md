# ADR 0051: User-controlled trust broker core

## Status

Accepted for the first implementation slice.

## Decision

OpenSesame models identity evidence, authentication facts, wallet activation,
credential presentation, and authorization as separate concepts. New policy
uses composable assurance facts and explicit requirements; the legacy
`AssuranceLevel` remains only as a conservative compatibility projection.

Evidence stores provenance and digests, never raw upstream tokens or raw
credentials. A trust session stores only an opaque proof-key handle and public
assurance metadata. A signed presentation requires a transaction-bound local
activation. Presentation intents crossing agent boundaries are opaque and
request-digest bound.

Protocol adapters (OIDC4VP, OIDC4VCI, FedCM, Digital Credentials API,
Federation, SD-JWT VC, and status lists) are independently feature-gated and
default off. This slice deliberately provides the pure domain and evaluator
foundation; an enabled flag does not imply protocol conformance.

## Consequences

The evaluator can fail closed without network access or UI. Removing evidence
cannot improve a decision, workload facts cannot satisfy human requirements,
and MFA is not inferred to be phishing-resistant. Offline presentation remains
bounded by credential expiry and explicit freshness policy.
