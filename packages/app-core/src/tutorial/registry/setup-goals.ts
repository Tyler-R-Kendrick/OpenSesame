import type { GuideGoalDescriptor } from "./goals.js";

/**
 * Goals for the gates and the ceremony behind them: opening the vault, the
 * front door's setup road, setup itself, and the connectors it brings across
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
      'say "Nothing has to be set up first: sign in, continue as guest, or seal a local vault. Setting up your own is for whoever runs this deployment — connectors, the model, sign-in and a second step, every tab skippable."',
      'focus "unlock.setup" "The operator road. Name a connector directory, choose who signs people in, and it records that and returns to sign-in." side=top',
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
      'say "Join a session with an invite (a link and a code), or ask into an open session at an endpoint. The operator approves this browser, a passkey proves it is you, and only then is the invite looked up."',
      'focus "setup.join" "An invite link opens this by itself." side=top',
      "end",
    ].join("\n"),
  },
];

export { SHELL_GOALS } from "./shell-goals.js";
export { TRANSPORT_GOALS } from "./transport-goals.js";
