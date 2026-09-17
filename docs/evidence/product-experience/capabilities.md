# Capability matrix

| Capability | Direction | Availability | Evidence |
| --- | --- | --- | --- |
| Visual/Source vault prefs | local | implemented, tested | `apps/pages/src/lib/configuration/*.test.ts` |
| Prefs aliases | local | implemented, tested | `registry.test.ts` |
| Command palette metadata search | local | implemented, tested | `nav.test.ts` |
| Saved views | local | implemented (query only), tested | `nav.test.ts` |
| Host config create in UI | Host | implemented, tested | `SecretConfigEmptyCreate.test.tsx` |
| Hosted OIDC claims beyond `sub` | Identity | implemented, tested | `projectAccountClaims` + `/v1/oauth/clients/:id/claim-preview` |
| `client_credentials` | Identity | implemented, tested | confidential `private_key_jwt` + public JWKS persisted in Postgres (`token_endpoint_jwks`); `POST /token` mint/deny/replay/retirement/suspend on a PGlite-backed issuer |
| OAuth2 Proxy recipe | inbound OIDC consumer | implemented, tested | pinned `v7.8.2` public PKCE config; live binary `/ping` vs Identity discovery (`oauth2-proxy-live.test.ts`) |
| Hosted Visual/Source client editor | Identity UI | implemented, tested | `EditApplication` PATCH adapter |
| SCIM group-id role mappings | inbound SCIM | implemented, tested | org-owner `/scim/mappings` + Groups PATCH |
| Durable `private_key_jwt` jti fence | Identity | implemented, tested | `DurableJwtReplayCache` + replica test |
| First-admin enrollment tickets | Identity | implemented, tested | `/v1/enrollment/*` + replica-enrollment |
| SCIM Groups selector-remove | inbound SCIM | implemented, tested | `scim-groups.test.ts` |
| SCIM deprovision across instances | inbound SCIM | implemented, tested | `replica-scim.test.ts` |
| Static Pages guest/no-backend | local | implemented, tested | `verify:static` (J-LOCAL) |
| Keyboard contract | local | implemented, tested | `verify:keyboard` |
| Touch/mobile contract | local | implemented, tested | `verify:mobile` (J-TOUCH) |
| SAML IdP | outbound | not implemented | excluded |
| LDAP server | outbound | not implemented | excluded |
| Outbound SCIM | outbound | not implemented | excluded |
| Reverse proxy | n/a | not implemented | use a standard proxy; OAuth2 Proxy is a recipe, not native |
| Prefs source sidecar | local | implemented, tested | `config/prefs.source.yaml` survives lock/unlock through VaultStore/VFS |

`pnpm verify:experience` **EXIT 0** at 2026-09-17T22:02Z: Pages **36/186**, oauth-provider **3/31**, control-plane **13/34** (includes `oauth2-proxy-live`), database **migrate-0027-0028**, plus static/keyboard/mobile/auth/local-iam and experience journeys J-CONFIG…J-SUPPORT. GitHub required checks success on baseline SHA. Two-build Settings Visual/Source gallery: `docs/evidence/product-experience/screenshots/`.

### Journey coverage (honest)

Playwright against the built dist: **J-LOCAL** (`verify:static`), **J-CONFIG / J-FILE / J-CONFLICT / J-NAV / J-APP / J-RECIPE** (`verify-experience-journeys.mjs`), **J-TOUCH** (`verify:mobile`), **J-ACCESSIBLE** (`verify:keyboard`; no manual screen-reader), **J-AGENT** local grants (`verify:local-iam`). Local-IAM request approval is **not** the hosted inbox journey. J-APP here is local Identity registration, not a hosted RP login.

Local Identity/control-plane integration (PGlite / `startServer`, not production): **J-SERVICE**, **J-SCIM**, **J-REPLICA**, **J-ADMIN** API denials. Independent adversarial re-run: 6 files / 20 tests, exit 0.

**Built-app Playwright (verify-experience-journeys):** J-TYPES, J-HOST-CONFIG, J-EXPLAIN, J-APPROVAL (local filterInboxRows; hosted inbox still Identity-gated), J-RECOVERY, J-SUPPORT. Named commitApproval/WebMCP human_only checks remain unit beside verify:local-iam.

Adversarial panel report: `docs/evidence/product-experience/adversarial-panel.md`.

Closed: GitHub required checks (TypeScript/Bundle budgets/Rust success on baseline SHA), PGlite `db:migrate` of 0027/0028, live oauth2-proxy v7.8.2 `/ping`. Still withheld: human participants, production DATABASE_URL migrate, paid-tenant Identity, multi-VM replicas.

No claim of production-readiness, competitor parity, instant revocation everywhere, or that unit coverage is a Playwright journey.
