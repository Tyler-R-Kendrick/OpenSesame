import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";

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
  // Core: the account's rows are always-on `identity.federation` (ADR 0140 D10).
  {
    id: "identity.account-factors",
    title: "Add a passkey or authenticator app to your account",
    requires: ["identity.connected"],
    // Offered where the rows are, not on every route (the context budget).
    routes: ["/settings"],
    guide: [
      "guide/1",
      'goal "identity.account-factors"',
      "say \"Your account's passkeys and authenticator app prove it is you to your sign-in service. They never open a vault: the vault's own keys are the lists above them.\"",
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.account-factors" "Press Add on Account passkey or Account authenticator app; the sheet makes it with your sign-in service. Remove on a row takes one away." side=bottom',
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
      'say "Join a live session from the link its owner shared (and, for an invite, the code they gave you another way). Send the owner the request code this page makes and paste back their reply code, or let the carrier the link names pass them, and the two browsers connect. What they share stays in this tab only until the session ends."',
      'focus "setup.join" "A shared link opens this by itself." side=top',
      "end",
    ].join("\n"),
  },
];

/** What the unlock screen and setup answer to a question about them. */
export const SETUP_HELP: readonly HelpTopic[] = [
  {
    id: "help.unlock",
    title: "How do I unlock the vault?",
    answer:
      "The unlock screen is the passkey, PIN or master password challenge for this device. Signing in with an identity provider is a separate tab and does not unwrap the vault key.",
    routes: ["/unlock"],
    goal: "unlock.open",
    keywords: [
      "unlock",
      "open",
      "locked",
      "master password",
      "pin",
      "passkey",
      "get in",
      "sign in",
    ],
  },
  {
    id: "help.setup",
    title: "How do I choose who can sign in?",
    answer:
      "An empty device offers two roads: set it up as the operator, or join a session you were invited to. The operator road is the allowlist of sign-in providers; finish records it and returns to sign-in. An empty list is a local-only vault.",
    routes: ["/setup"],
    goal: "setup.first-run",
    keywords: [
      "setup",
      "set up",
      "first run",
      "operator",
      "allowlist",
      "who can sign in",
      "sign-in providers",
      "join",
      "new device",
      "install",
    ],
  },
];

export { SHELL_GOALS } from "./shell-goals.js";
