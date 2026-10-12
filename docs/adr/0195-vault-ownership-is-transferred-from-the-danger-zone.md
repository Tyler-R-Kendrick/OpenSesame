# ADR 0195 — A vault's owner can hand it to another registered user from the Danger zone

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** OpenSesame maintainers
- **Supplements:** ADR 0105 ([browser-local organization membership](0105-browser-local-organization-membership.md)),
  ADR 0158 ([Settings rows act or are absent](0158-settings-rows-act-or-are-absent.md)),
  ADR 0178 ([authorization checks are proofs the compiler can see](0178-authorization-checks-are-proofs-the-compiler-can-see.md)),
  ADR 0089 ([several vaults on one device](0089-device-vault-switching.md))

## Context

A vault had an owner and no way to change one. A person who set a vault up
for a team, or who is leaving it, could only delete it. GitHub puts "Transfer
ownership" in a repository's Danger zone, beside "Delete this repository", and
asks for the name to be typed back. Settings already has that place
(`SettingsDangerPanel`).

## Decision

1. **The row lives in Settings › Danger zone**, above "Delete this vault".
   It is an icon key opening a sheet; the sheet lists the people who can
   receive the vault, asks for the chosen person's name to be typed back, and
   carries one danger key. Per ADR 0158 the row is absent unless the person
   acting owns the vault and at least one other person could receive it.
2. **Only registered users can receive it.** In the browser-local plane the
   recipient is an *enabled `person`* in the vault's own directory
   (`config/identity-directory`). Guest placeholders, agents, applications,
   organizations and disabled people are refused (`lib/vault-ownership.ts`).
   On the Identity API the recipient must be an *active* principal who is
   already a member of the project; a provisional principal is a guest.
   The person handing it over may be the custodian of a vault sealed without
   an account, whose owner person is a guest-named placeholder: only the
   recipient must be registered. That placeholder becomes a member, since a
   guest cannot be an admin.
3. **The recipient becomes owner; the previous owner stays on as an admin.**
   The recipient is promoted first, so the directory never has no owner
   between the two writes, and both run under one directory lock.
4. **The Identity API has the same operation**, `POST /v1/projects/{id}/transfer`,
   for projects held there. Owner only, standard projects only (the personal
   project is immutable and a temporary one is claimed), and `confirm` must
   equal the project slug. A recipient may instead be an organization the
   caller owns. The check demands a `ProjectOwner` proof (ADR 0178), and the
   change is audited as `project.transferred`.
5. **It does not move the key.** Ownership is who administers the vault. The
   sealed vault opens for whoever holds a key; sharing one is the existing
   step in Settings › Vaults (ADR 0089), and the sheet says "Vault key: not
   moved" rather than imply otherwise.
6. **No agent surface.** `identity.local.vault.transfer` is registered as a
   page-only ceremony with no CLI, MCP or WebMCP mapping: agents are never owners, and a model never hands a vault to a person.

## Consequences

- There is no acceptance step. A recipient must already be a registered user
  of the vault, which is the check an invitation would otherwise provide; a
  mistaken transfer is undone by the new owner, not by the previous one.
- A vault whose directory has several owners is ambiguous: the signed-in
  local person must be one of them, or the only owner must be the custodian.
- A device-only vault with no registered user besides its owner shows no row.
- `openapi.ts` gave up its project membership blocks to
  `openapi-projects.ts` to stay within its line budget; the published
  document is unchanged apart from the new path.
