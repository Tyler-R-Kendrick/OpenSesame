# Identity plane threat model (addendum)

Extends `docs/security/threat-model.md` for the TypeScript identity plane.

| Threat | Control | Test |
|--------|---------|------|
| Email auto-link takeover | No unique email; no auto-link | auth-upstream |
| Pairwise sub correlation | Sector pairwise store | oauth-provider |
| Claim token in logs/referrer | Fragment transport docs; redaction; hashed storage | os-domain / observability |
| Claim race double-spend | Version CAS / row lock | claims |
| Device≠claim confusion | Separate models + UI copy | device-auth / console |
| Origin client abuse | Feature flag + scope deny offline_access | oauth-provider |
| CIMD/DCR SSRF | Disabled by default; SafeMetadataFetcher denylist | oauth-provider |
| Upstream token passthrough | Discard after map; never as OpenSesame AT | auth-upstream / oauth |
| Provisional privilege carryover | Re-eval grants on claim; policy deny | policy / claims |
| Canonical principal as `sub` | Pairwise only | oauth-provider |

Residual: same-UID host/container escape without sandbox; MITM proxy not primary (ADR 0006).
