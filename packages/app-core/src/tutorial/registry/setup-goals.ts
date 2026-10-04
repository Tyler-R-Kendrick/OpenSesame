import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";

/**
 * Goals for the account menu and the sign-in rows it leads to. The gates
 * themselves have none: the Support sheet is never mounted there (ADR 0090,
 * ADR 0161 §4), so a walkthrough written for one could not be started.
 */
export const SETUP_GOALS: readonly GuideGoalDescriptor[] = [
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
    id: "identity.sign-in",
    title: "Sign in with an identity provider",
    routes: ["/identity"],
    guide: [
      "guide/1",
      'goal "identity.sign-in"',
      'say "Sign-in is a ceremony against a provider this deployment already registered. Nothing here mints a vault key."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'focus "shell.account" "Open the account menu. Sign in, or Add an account when one is already signed in, leads to the sign-in screen." side=bottom',
      'wait target "shell.account" event=activate timeout=30000',
      'success "Choose a provider on the Sign in tab. The vault still opens with the local unlock on this device."',
      "end",
    ].join("\n"),
  },
  {
    id: "identity.sign-out",
    title: "Sign out of this device",
    routes: [],
    requires: ["account.signed-in"],
    guide: [
      "guide/1",
      'goal "identity.sign-out"',
      'say "Signing out ends the account on this device: the Identity session is revoked, the upstream sign-in is forgotten, and the vault locks. The vault key is a separate thing — locking alone keeps you signed in."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'focus "shell.account" "The first segment of the prompt names the account. Open it; Sign out is the last entry." side=bottom',
      'wait target "shell.account" event=activate timeout=30000',
      'success "The unlock screen says you are signed out. Sign in again from the user menu, or continue as a guest."',
      "end",
    ].join("\n"),
  },
  {
    id: "identity.switch-account",
    title: "Sign in as somebody else",
    routes: [],
    requires: ["account.signed-in"],
    guide: [
      "guide/1",
      'goal "identity.switch-account"',
      'say "Switching signs this device out and starts a fresh sign-in. An OpenID issuer is asked to authenticate again; a Google account through shoo.dev is the one shoo.dev remembers, and a different one means signing out at shoo.dev/me first."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'focus "shell.account" "Open the account menu and choose Switch account." side=bottom',
      'wait target "shell.account" event=activate timeout=30000',
      'success "Choose the account to sign in with from the user menu."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.second-step.code",
    title: "Add a fallback second step by email or text",
    routes: [],
    requires: ["signin-service.configured"],
    guide: [
      "guide/1",
      'goal "vault.second-step.code"',
      'say "A code by email or text is a fallback for a lost phone, not a first second step: it needs a sign-in service to send it, and anyone who can read the inbox or hold the number can read the code. Keep an authenticator app or passkey enrolled too."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.second-step" "Press Add on Email code or Text message. The sheet asks where to send it, sends the first code, and turns the channel on only once that code matches." side=bottom',
      "end",
    ].join("\n"),
  },
];

/**
 * What the unlock screen and setup answer to a question about them: written
 * help only, since a gate has no Support sheet to start a walkthrough from.
 */
export const SETUP_HELP: readonly HelpTopic[] = [
  {
    id: "help.unlock",
    title: "How do I unlock the vault?",
    answer:
      "The unlock screen is the passkey, PIN or master password challenge for this device. Signing in with an identity provider is a separate tab and does not unwrap the vault key.",
    routes: ["/unlock"],
    goal: null,
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
    goal: null,
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
