# Certificate issuance-history tenant isolation audit

Date: 2026-08-25

Codex Security CLI 0.1.20 (plugin 0.1.37) reviewed the complete 12-file set
resolved from seven certificate/custody paths using ChatGPT authentication,
GPT-5.6 Luna, low effort, standard mode, and a USD 15 scanner estimate cap.
The targeted run estimated USD 0.09094584.

The review confirmed one medium-severity issue in the development-only
ephemeral certificate repository. Issuance metadata was stored under a
host-global key, so listing history could cross organization boundaries. The
durable database path was already organization-scoped.

Commit `5da2361` binds the ephemeral key and every load/save call to the resolved
organization. The regression test
`adversarial_ephemeral_history_isolated_between_organizations` proves that one
organization cannot enumerate another organization's issuance metadata.

This was a targeted review, not a repository-wide security claim. Scanner
artifacts remain private because they contain detailed source paths and threat
analysis.
