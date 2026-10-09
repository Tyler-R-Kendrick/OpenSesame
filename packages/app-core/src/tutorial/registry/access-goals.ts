/**
 * Goals and authored help the `access.authority` capability contributes,
 * alongside `authority-help.ts` (the Host-authority topics and their goals).
 */

import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";

export const ACCESS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "access.grant",
    title: "Grant an agent access",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.grant"',
      'say "A share is a grant. The person or agent it is for gets use of it under a policy, never the credential behind it."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access/shares"',
      'wait route "/access/shares" timeout=15000',
      'focus "access.grant-access" "This opens a share: who it is for, what it opens, how narrowly, and for how long." side=bottom',
      'wait target "access.grant-ceremony" event=appear timeout=60000',
    ].join("\n"),
  },
  {
    id: "access.relay",
    title: "Create and review access requests",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.relay"',
      'say "Requests contains your approval inbox and relay asks. New requests need an approver inbox address and an exact action. Review the digest and complete any required passkey or comparison ceremony. Consent alone does not mint a grant."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.requests" "Create, approve or deny on Requests. Each request is its own decision; nothing is auto-approved." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "access.sessions.review",
    title: "Review running agent tasks",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.sessions.review"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.sessions" "Sessions starts task runs with an explicit action, resource and deadline. Inspect the ceiling or terminate a run here; its ceiling does not grant resource access." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "access.connectors",
    title: "Bind a connector to a person or agent",
    routes: ["/access"],
    guide: [
      "guide/1",
      'goal "access.connectors"',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'say "Connectors are configured or imported on the Connections page. Granting one to a person or agent is the PAM decision: which policy, until when. No token ever reaches this device."',
      'focus "access.connectors" "The Connectors branch: Add chooses a connector and who may use it. Open a record to revoke its grant early." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "access.review",
    title: "Review grants, resources and policies",
    routes: ["/access"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "access.review"',
      'say "Three branches of Access hold what stands between an application and this vault: what has been shared, what could be shared, and how widely each application may ask. This tour only points; nothing changes until you act on a record."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.grants" "Grants lists what is already shared: the application grants this vault issued and its identity shares, each with an expiry. Revoking an application grant asks you to confirm first." side=bottom',
      'focus "access.resources" "Resources lists what a grant can point at: the vaults on this device, this application and this device, and any connection a share names. Each row says who holds a standing share of it, or that none does." side=bottom',
      'focus "access.policies" "Policies has one record per local application. Open its Application registration for the exact callbacks it may return to and the roles allowed per permission; a role left unchecked is denied, owners included." side=bottom',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'success "Grants say what is shared, Resources what can be, and Policies how widely an application may ask."',
      "end",
    ].join("\n"),
  },
  {
    id: "access.requests.hosted",
    title: "Review requests sent to your account",
    routes: ["/access"],
    libraryOnly: true,
    // The panel is drawn only where an Identity API address is set.
    requires: ["signin-service.configured"],
    guide: [
      "guide/1",
      'goal "access.requests.hosted"',
      'say "With an Identity API set, requests that name your account arrive on Requests beside the local ones. A row opens its full review; the list itself never approves or denies."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access/requests"',
      'wait route "/access/requests" timeout=15000',
      'focus "access.relay" "Requests for you. Open a row to read exactly what it would allow; the decision is made there, bound to that one request. Reload reads again for any that arrived since." side=bottom',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'success "Anything you do not recognize, report from its review instead of approving."',
      "end",
    ].join("\n"),
  },
];

export const ACCESS_HELP: readonly HelpTopic[] = [
  {
    id: "help.access.grant",
    title: "How do I give an agent access to something?",
    answer:
      "Access → Grants → the add key on Identity shares. You choose who it is for, what is shared, the policy it runs under and how long it lasts. The person or agent gets use of it, never the credential behind it.",
    routes: [],
    goal: "access.grant",
    keywords: [
      "agent",
      "access",
      "grant",
      "delegate",
      "delegation",
      "share",
      "permission",
      "claim code",
      "scope",
      "allow",
      "authority",
      "token",
    ],
  },
];
