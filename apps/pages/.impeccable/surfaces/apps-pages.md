---
version: 1
slug: "apps-pages"
primary_target: "apps/pages"
related_targets: ["apps/pages/index.html","apps/pages/src/pages/VaultPage.tsx","apps/pages/src/pages/UnlockPage.tsx"]
---

# Surface brief: apps/pages vault

## Scope & mode
Operate — Bitwarden-class authority vault PWA for humans and agents.

## Audience / job
Humans managing sealed authority items; agents consuming the same vault without raw secret export.

## Task
Unlock session → search/filter vault → open item or Agent peer view → Tools for ceremonies → Settings for API bases.

## Constraints
Static Pages; remote Host/Identity; no secrets in UI; synthetic labeled; no sudo; OPFS KV (no localStorage); no custom Actions.

## Direction
User-pinned competitor path: Bitwarden (+ assumed 1Password) craft bar. Light content, navy sidebar, teal accent, unlock-first.

## Memorable moment
Unlock card stating session PIN never decrypts sealed OPFS into the page — then a searchable vault list.

## Unresolved
Confirm whether 1Password stays as companion craft bar or Bitwarden alone.
