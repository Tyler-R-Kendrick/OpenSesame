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
      'say "A grant is a delegation. The agent receives a handle, never the credential behind it."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.grant-access" "This starts the ceremony: what is shared, how narrowly, and who it is for." side=bottom',
      'wait target "access.grant-ceremony" event=appear timeout=60000',
    ].join("\n"),
  },
  {
    id: "access.claim",
    title: "Claim a grant",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.claim"',
      'say "In Access → Grants, choose Claim access. Enter the token and code, review the offered scope, then accept. Presentation is single-use."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      "end",
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
    routes: ["/access", "/setup"],
    guide: [
      "guide/1",
      'goal "access.connectors"',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'say "Connectors are read by reference from a Nango-compatible directory. Binding one to a person or agent is the PAM decision: which policy, until when. No token ever reaches this device."',
      'focus "access.connectors" "The Connectors tab: sync the directory once, then Bind under a row. Revoke ends a binding early." side=bottom',
      "end",
    ].join("\n"),
  },
];

export const ACCESS_HELP: readonly HelpTopic[] = [
  {
    id: "help.access.grant",
    title: "How do I give an agent access to something?",
    answer:
      "Access → Grants → Grant access. You choose what is being shared, narrow what may be done with it, decide who it is for, and mint a claim code. The agent receives a delegation, never the credential behind it.",
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
