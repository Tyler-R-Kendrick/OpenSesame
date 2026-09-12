import type { GuideGoalDescriptor } from "./goals.js";

/**
 * Goals for the gates and the ceremony behind them: opening the vault, the
 * front door's two roads, setup itself, and the connectors it brings across
 * (ADR 0115). Authored GuideLang, compiled by the same parser model output
 * goes through.
 */
export const SETUP_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "unlock.open",
    title: "Unlock the vault",
    routes: ["/unlock"],
    guide: [
      "guide/1",
      'goal "unlock.open"',
      'say "The vault is sealed on this device. First run leads with sign-in; a returning vault uses the unlock form for a passkey, PIN or password."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'success "Unlocked. The vault key is in memory on this device only."',
      "end",
    ].join("\n"),
  },
  {
    id: "setup.first-run",
    title: "Set up this deployment (optional)",
    routes: ["/unlock"],
    guide: [
      "guide/1",
      'goal "setup.first-run"',
      'say "Nothing has to be set up first: sign in, continue as guest, or seal a local vault. Setting up your own is for whoever runs this deployment — connectors, sign-in and backups, every tab skippable."',
      'focus "unlock.setup" "The operator road. Name a connector directory, choose who signs people in, and it records that and returns to sign-in." side=top',
      'hint "setup.join" "Join if you were invited: a link and a code, or a public session to ask into." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "setup.operator",
    title: "Choose who signs people in",
    routes: ["/setup"],
    guide: [
      "guide/1",
      'goal "setup.operator"',
      'say "Setup is a tab per concern, every one skippable. Connectors already authorized in a Nango-compatible directory come across by reference; the identity tab is the allowlist of who may sign people in."',
      'focus "setup.ways" "Each road you add here appears on the sign-in screen. Removing all of them is a local-only vault." side=bottom',
      'hint "setup.finish" "This records the roads and returns to sign-in." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "setup.join-session",
    title: "Join a session",
    routes: ["/unlock"],
    guide: [
      "guide/1",
      'goal "setup.join-session"',
      'say "Join a session you were invited to: a link and a code, or a public session to ask into."',
      'focus "setup.join" "This road never asks you to be the operator. The Host is asked for only here, because sharing reintroduces the server." side=top',
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
      'say "Connectors are read by reference from a Nango-compatible directory, or brokered by a Host. Binding one to a person or agent is the PAM decision: which policy, until when. No token ever reaches this device."',
      'focus "access.connectors" "The Connectors tab: sync the directory once, then Bind under a row. Revoke ends a binding early." side=bottom',
      "end",
    ].join("\n"),
  },
];
