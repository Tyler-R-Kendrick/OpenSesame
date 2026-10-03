# ADR 0153 — Minimal PWA: vault, activity, settings

- Status: Accepted
- Date: 2026-09-29
- Amends: [ADR 0142](0142-capabilities-page-one-list-honest-defaults.md)
  (browser-local IAM and SIOP are no longer always on)
- Supplements: [ADR 0130](0130-operator-controlled-capability-composition.md),
  [ADR 0087](0087-vault-item-type-plugins.md)

## Context

ADR 0142 made browser-local IAM, SIOP, the site broker and git backup
always on, because a default install already ran them and a "deselected"
row misdescribed that. The same treatment had already been given to the
Connections catalogue, the Access section, operator identity providers
and passkey and certificate records.

A bare installation should not carry those sections. The sections a
person can open with nothing switched on are the vault, the activity
trail and settings. The vault's creatable type in that installation is
the generic secret. Every other built-in type already projects onto that
secret through `spec.native`.

## Decision

1. `connectors.external`, `access.authority`, `identity.local-iam`,
   `identity.siop`, `identity.federation` and `identity.ambient-sso` are
   optional. Each has one Settings › Capabilities switch (Connections,
   Access, Identity). The OpenFeature flag is `capability.<id>`, the
   projection of that capability's approved bit. Unselected, the module
   is not loaded and the route is not registered.
2. The site broker and git backup stay always on. Git backup does not
   depend on `connectors.external`: the Connections section is the
   connector UI, and the backup observer does not require it.
3. `vault.passwords` declares the item kind `secret` only.
   `vault.derived-records` owns the other built-in types except passkey,
   certificate and drop. Passkey and certificate records are optional.
   Those three capabilities are the Item types switch, off in the
   minimal plan. A stored record of an excluded kind still opens.
4. `activity.log` stays always on, so the minimal rail is vault,
   activity and settings.
5. `minimal-local` still approves zero optional capabilities.
6. `support.local-ai`, `support.remote-ai` and `agents.webmcp` stay
   optional and unselected. The status bar parses commands — navigate,
   search, copy — directly. It hands a sentence to a model only while
   one of the model capabilities is approved. Guided help stays always
   on and does not turn the bar into an ask box.

## Consequences

- A fresh personal install has no `~/connections`, `~/access` or
  `~/identity` until those switches are on, and the status bar does not
  ask a model until On-device model or Remote support model is on.
- Enabling directory provisioning or CA administration pulls in the
  optional capabilities those descriptors already depend on
  (`identity.federation`, `access.authority`, `vault.certificate-records`),
  and the instance policy has to permit them.
- The connector pages are routed only while Connections is on, so a
  Settings › Capabilities tile links to one only then; with it off, a git
  history road is its enable switch alone and the connectors that have only a
  page are not drawn ([ADR 0151](0151-connector-pages-act-on-the-roads-a-device-has.md),
  third amendment).
- A version-1 preset residue no longer strips `identity.local-iam` or
  `identity.siop`. The site broker and git backup are still stripped.
