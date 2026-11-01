# Cloudflare audit dispositions

This is the maintained index of the historical Cloudflare audit findings.
[`findings.json`](findings.json) retains all **23 unique fingerprints** found
across the committed audit runs, their latest recorded verdicts and exact
recorded disposition reasons. No finding was dropped during consolidation.
All 23 latest recorded verdicts were `rejected`; earlier runs also recorded
confirmed findings and leads awaiting validation. The complete traces,
reproductions and earlier dispositions remain in Git history.

This index is **not a current security assessment**. Its source product commit
was `cfa60722e1c26403c0d833fb230c48a5db07bd44`. The latest run's metadata still
says `in_progress`, with hunting incomplete. This cleanup did not rerun a scan,
validate fixes against the current head, or establish that the repository is
secure. Historical rejections must not be interpreted as a fresh approval.

## Historical detail

- [Latest recorded findings and full traces](https://github.com/OpenSesame-Labs/OpenSesame/blob/fd554446241e32962e82763ddb772f9420096279/docs/security/cloudflare-audit/run-8/findings.json)
- [Latest recorded run scope and incomplete status](https://github.com/OpenSesame-Labs/OpenSesame/blob/fd554446241e32962e82763ddb772f9420096279/docs/security/cloudflare-audit/run-8/run-metadata.json)
- [Recorded resolutions of the six validation leads](https://github.com/OpenSesame-Labs/OpenSesame/blob/fd554446241e32962e82763ddb772f9420096279/docs/security/cloudflare-audit/run-3-needs-validation-resolutions.md)
- [Full historical audit tree](https://github.com/OpenSesame-Labs/OpenSesame/tree/fd554446241e32962e82763ddb772f9420096279/docs/security/cloudflare-audit)
- [Historical PR review transcripts and verdicts](https://github.com/OpenSesame-Labs/OpenSesame/tree/fd554446241e32962e82763ddb772f9420096279/kimi-reviews)

## Keeping this small

Keep one maintained finding/disposition record per fingerprint. A new
confirmed or unresolved issue updates this index with its actual validation
scope, disposition and source/test references. Do not copy forward the old
coverage ledger or claim that an old rejection resolves a changed path.

Store raw scanner output, coverage ledgers, agent assignments, transcripts,
review drafts and per-run reports in private run storage or ignored
`work/audit/`. Keep review discussions with their pull request. Link prior
records by commit SHA; never append `run-*` or `pr*-review.txt` collections
to the default branch. Approved current implementation evidence follows
[`docs/evidence/README.md`](../../evidence/README.md).
