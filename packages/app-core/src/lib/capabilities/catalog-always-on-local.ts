/**
 * Always-on descriptors — the browser-local functions (ADR 0138). Each runs
 * entirely in this browser on the static front end: no Host, no Identity
 * API, no automatic call until a person binds something. The default
 * installation always had them in reach (a git history remote defaults to
 * GitHub, a local application can already sign in here), so presenting them
 * as opt-ins the device had "deselected" misdescribed what it runs.
 *
 *  - `identity.local-iam` — this device as an identity host;
 *  - `identity.siop` — self-issued OpenID answered by that host;
 *  - `identity.site-broker` — the static-auth broker this origin serves;
 *  - `backup.git-remote` — encrypted snapshots to a git remote a person
 *    binds; the observer honours the plan's network envelope.
 */

import { type AuthoredDescriptor, alwaysOn } from "./descriptor.js";

export const BROWSER_LOCAL_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  alwaysOn(
    "identity.local-iam",
    "Browser-local IAM",
    "This device as an identity host: the local directory of people, agents, devices and applications, local passkeys, application sign-in and grants.",
    {
      operationIds: [
        "identity.local.agent.keys.manage",
        "identity.local.application.authorize",
        "identity.local.directory.manage",
        "identity.local.passkeys.manage",
      ],
      egress: [
        {
          class: "user-mediated-navigation",
          purpose: "the redirect back to a registered local application",
          automatic: false,
        },
      ],
      browserPermissions: ["webauthn"],
      keyAccess: "protector-wrap",
    },
  ),
  alwaysOn(
    "identity.siop",
    "Self-issued OpenID",
    "Answer SIOPv2 requests from a registered local application with a self-issued token, gated on a passkey identity.",
    {
      dependencies: ["identity.local-iam"],
      operationIds: ["identity.local.siop.authorize"],
      egress: [
        {
          class: "user-mediated-navigation",
          purpose: "the fragment redirect back to the requesting application",
          automatic: false,
        },
      ],
      browserPermissions: ["webauthn"],
    },
  ),
  alwaysOn(
    "identity.site-broker",
    "Sign-in broker for sites",
    "Broker a brokered identity to approved relying sites over postMessage: the broker popup, the per-site consents and domain policy, and the static-auth SDK files this origin serves.",
    {
      egress: [
        {
          class: "user-mediated-navigation",
          purpose: "postMessage delivery to a relying site's approved origin",
          automatic: false,
        },
      ],
      offlineLimits:
        "A relying site can only be answered while the upstream broker is reachable.",
    },
  ),
  alwaysOn(
    "backup.git-remote",
    "Git remote backup",
    "Push encrypted vault snapshots to a private repository through the GitHub App or a forge git remote, and sync them back.",
    {
      dependencies: ["connectors.external"],
      operationIds: [
        "backup.status",
        "backup.target.set",
        "sync_targets.read",
        "sync_targets.trigger",
      ],
      egress: [
        {
          class: "external-service",
          purpose:
            "the bound git remote or the GitHub App relay, after every vault mutation",
          automatic: true,
        },
      ],
      keyAccess: "provider-bearer",
      requiresService: true,
      offlineLimits:
        "Snapshots queue locally and push when the remote is reachable.",
    },
  ),
];
