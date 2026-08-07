# Brief implementation status

Status against the OpenSesame one-shot implementation brief as of the `feat/brief-api-gaps` slice.

## Intentional deviations

| Brief | Repository | Reason |
|-------|------------|--------|
| `packages/domain` | `packages/os-domain` | Avoid npm name collision with generic `domain` packages |
| Dual-plane Host (`gateway`) + Identity (`control-plane`) | ADR 0017 | Product topology already shipped; brief’s single “control-plane” maps to Identity API |
| Clerk / Vercel Marketplace auth | **Not used for core** | ADR 0004; brief requires Better Auth + panva/oidc-provider |
| Full greenfield from empty tree | Preserve existing sound code | Repository already contained vertical-slice implementation |

## APIs closed in this slice

- `POST /v1/principals/link-identities` — tuple uniqueness; **no email auto-link**
- `GET /v1/principals/identities`
- `DELETE /v1/principals/identities/:id`
- `GET|POST /v1/organizations`, `GET /v1/organizations/:id`
- `GET|POST /v1/oauth/clients`, patch/rotate/revoke (pre-registered only)
- `GET /v1/audit/events` — principal-scoped list

## Feature gates (remain disabled by default)

- Origin-profile clients
- Dynamic Client Registration
- Client ID Metadata Documents
- Experimental AT Protocol / Nostr adapters

## Evidence

Run:

```bash
pnpm --filter @opensesame/control-plane test
pnpm --filter @opensesame/claims test
pnpm --filter @opensesame/oauth-provider test
```
