# Contracts

- **C-RESOURCE** — `apps/pages/src/lib/configuration/types.ts`, `registry.ts`, `aliases.ts`. Display paths are aliases. Forbidden ledgers fail closed.
- **C-DOCUMENT** — YAML 1.2 JSON-compatible profile via `yaml` (`yaml-profile.ts`, `yaml-patch.ts`, `draft.ts`). No-edit mode switch keeps bytes. Invalid source stays editable.
- **C-COMMIT** — `prefs-adapter.ts`, `local-application-source.ts`. Outcomes: applied_durable, conflict, refused. Comment-only saves do not invalidate grants.
- **C-COMMAND** — `actions.ts`, `keybindings.ts`. `/` remains pane search. Bindings cannot name URLs.
- **C-VIEW** — `views.ts`. A view is a query scoped to a collection; scope mismatch drops it.
- **C-EVALUATE** — `evaluate.ts`. Decisions are allow / deny / indeterminate from the same function.
- **C-PORTABLE** — `recipes.ts`. Allowlisted semantics; secrets and owners stripped.
- **C-MACHINE / C-SCIM / C-ADMIN** — hosted packages (`oauth-provider`, `control-plane` SCIM). See ownership.json. Public clients cannot register `client_credentials`. Claim preview uses `previewAccountClaims` (unsigned). Org-owner SCIM mappings are explicit group-id → role.
- **C-MACHINE replay** — `JwtReplayCache` in oauth-provider; durable adapter `DurableJwtReplayCache` (`OpenSesame:JwtReplay`) when Identity has a database.
- **First-admin enrollment** — operator-minted hashed tickets at `/v1/enrollment/tickets` consumed once at `/v1/enrollment/bootstrap`. No public first-user-wins path.
