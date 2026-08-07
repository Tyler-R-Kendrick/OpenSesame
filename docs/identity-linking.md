# Identity linking & privacy

## Linking

- External identities are unique on `(kind, issuer, tenant, subject)`.
- Email is never a unique key and never auto-links accounts.
- Linking requires an authenticated principal + step-up for sensitive changes.
- Canonical `Principal.id` never changes when identities are attached.

## Pairwise subjects

Downstream tokens use sector pairwise `sub` values. Relying parties Alpha and Beta must receive different stable subjects for the same principal; neither equals `Principal.id`.

## Default claims

Default identity: `iss`, pairwise `sub`, `aud`, time claims, assurance/session context. PII requires explicit scopes and consent.

## Merge

Full merge is only supported when both principals are authenticated (or admin recovery). Otherwise collision detection returns a safe `merge_not_supported` workflow — never silent merge.
