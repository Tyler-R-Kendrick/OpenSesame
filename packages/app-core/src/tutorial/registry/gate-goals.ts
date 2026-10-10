import type { GuideGoalDescriptor } from "./goal-types.js";

/**
 * The tutorials of the screens in front of the shell: the front door, sign-in,
 * unlock, setup, the broker popup and the federation return (ADR 0166).
 *
 * Each is scoped to the one gate whose controls it points at, so the help key
 * a gate draws offers exactly the tours that can be walked there
 * (`tutorialStartsFrom`). A gate cannot navigate, so none of these may
 * `navigate`; a step points at a control that screen draws, or says something.
 * They are the same GuideLang, compiled by the same parser and checked by the
 * same budget as every other authored tour.
 */
export const GATE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "gate.front-door",
    title: "The front door: two roads and Skip",
    routes: ["/unlock/door"],
    guide: [
      "guide/1",
      'goal "gate.front-door"',
      'say "A device with nothing on it opens on two roads and a way past them. Nothing here asks who you are, and nothing on it needs a server."',
      'focus "unlock.setup" "Set up your own opens a few optional steps: what this installation runs, who can sign in, where it backs up. Every step can be skipped." side=bottom',
      'focus "setup.join" "Join a session opens somebody else\'s live session from a link they shared. The two browsers trade codes and connect directly." side=bottom',
      'focus "unlock.guest" "Skip opens a guest vault, sealed on this device and kept apart from any other vault on it. It is always one press away. Sealing without an account is the sign-in road, not this one." side=bottom',
      'success "Choose a road when you are ready. Nothing is stored until you do."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.join",
    title: "Join a session",
    routes: ["/unlock/door"],
    guide: [
      "guide/1",
      'goal "gate.join"',
      'say "Joining connects this browser to somebody\'s live session. You need the link its owner shared and, for an invite, the code they gave you another way. A shared link opens joining by itself."',
      'focus "setup.join" "Press it to join. Send the owner the request code this page makes and paste back their reply code, or let the carrier the link names pass them, and the two browsers connect." side=bottom',
      'say "The first time, it asks you to turn on Live sessions: a short review of what that adds, and nothing loads until you agree. What the owner shares stays in this tab until the session ends."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.sign-in",
    title: "Sign in, or seal this device without an account",
    routes: ["/unlock/signin"],
    guide: [
      "guide/1",
      'goal "gate.sign-in"',
      'say "First run leads with who you are. Signing in attaches an account to this device. It never replaces the key that seals the vault, and an account is optional."',
      'focus "unlock.signin" "Choose a provider. Each one signs you in there and brings you back here. Where an organization\'s sign-in is on offer, type its address instead." side=top',
      'focus "unlock.local-only" "Use without an account seals a vault on this device alone: no account, no sync and no account recovery. You choose a passkey or a PIN next." side=top',
      'success "Either way the vault is sealed on this device before anything is stored in it."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.unlock",
    title: "Open this device's vault",
    routes: ["/unlock/form"],
    guide: [
      "guide/1",
      'goal "gate.unlock"',
      'say "Unlock opens this device\'s vault with a key you enrolled. The key is checked in this browser, not by a server: the vault is decrypted here."',
      'focus "unlock.methods" "Each tab is a key this vault has: a passkey or a PIN, or a master password an older vault still holds. Pick the one you have." side=bottom',
      'focus "unlock.secret" "Type the key for the tab you picked. The eye in the field shows what you typed. Nothing is checked until you press the key below." side=bottom',
      'focus "unlock.submit" "This opens the vault. If you enrolled a second step, a code is asked for next: from your authenticator app, by email or text, or one of your recovery codes." side=top',
      'success "Once the vault is open, Settings, then Security, lists every key and second step."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.unlock.passkey",
    title: "Open this device's vault with a passkey",
    routes: ["/unlock/passkey"],
    guide: [
      "guide/1",
      'goal "gate.unlock.passkey"',
      'say "A passkey opens the vault with this device\'s own authenticator: a fingerprint, a face, a security key or the screen lock. There is no secret to type."',
      'focus "unlock.passkey" "This is the passkey tab. With it picked, the key below asks the browser for the passkey." side=bottom',
      'focus "unlock.submit" "Press it and approve on the device. If you enrolled a second step, a code is asked for next." side=top',
      'success "Another tab on the strip is another key. Any one of them opens the same vault."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.unlock.account",
    title: "Who is signed in on the unlock screen",
    routes: ["/unlock/form", "/unlock/passkey"],
    requires: ["vault.key-enrolled"],
    guide: [
      "guide/1",
      'goal "gate.unlock.account"',
      'say "The unlock screen answers two questions apart: who is signed in, and which key opens the vault. Signing in never unlocks anything. Only a key does."',
      'focus "unlock.account" "This menu names the account, or the guest, this device is signed in as. It lists the other vaults on this device, and offers Sign in and Sign out for the account." side=bottom',
      'success "Sign in here attaches an account. The key to the vault is still the one you enrolled."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup.choose",
    title: "Choose how to set this device up",
    routes: ["/setup/choose"],
    guide: [
      "guide/1",
      'goal "gate.setup.choose"',
      'say "Setup is optional. Nothing has to be answered before you can use the app, and Skip all leaves everything as it is."',
      'focus "setup.configurations" "Minimal is the vault, activity and settings. Default adds the default extensions, and Full turns everything on. Custom lets you pick individual capabilities." side=bottom',
      'success "Whatever you choose here can be changed later in Settings, then Capabilities."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup",
    title: "Walk through the setup tabs",
    routes: ["/setup/capabilities"],
    guide: [
      "guide/1",
      'goal "gate.setup"',
      'say "Setup is a tab for each concern, and every tab can be skipped. What you answer is written as you answer it, so backing out loses nothing."',
      'focus "setup.tabs" "The first tab is what this installation runs: a draft you review, then apply. The tabs after it belong to features that are on, such as connectors and who can sign in." side=bottom',
      'focus "setup.finish" "Finish records the roads you took and returns to sign-in. Skip this step moves on, and Skip all in the bar leaves every tab you have not opened as it was." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup.ways",
    title: "Choose who can sign in",
    routes: ["/setup/identity"],
    guide: [
      "guide/1",
      'goal "gate.setup.ways"',
      'say "This tab is the allowlist of sign-in roads: brokered providers, an operator\'s own issuers and, if there is one, an Identity service."',
      'focus "setup.ways" "Each road you add here appears on the sign-in screen. Removing all of them is a local-only vault." side=bottom',
      'hint "setup.finish" "Finish records the roads and returns to sign-in." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup.connectors",
    title: "Bring connectors across by reference",
    routes: ["/setup/connectors"],
    guide: [
      "guide/1",
      'goal "gate.setup.connectors"',
      'say "A connector arrives by reference, never by credential. Connectors already authorized in a Nango-compatible directory come across without their tokens."',
      'focus "setup.connectors" "Name the directory\'s endpoint and key, then Sync. The key is sealed in the vault, or held in memory until a vault exists to seal it." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup.keep",
    title: "Keep the app on this device",
    routes: ["/setup/capabilities"],
    requires: ["install.offered"],
    guide: [
      "guide/1",
      'goal "gate.setup.keep"',
      'say "The vault is stored on this device, and a browser may clear a tab\'s storage when the device runs short of room. An installed app is not treated that way."',
      'focus "setup.keep" "This offer has no wrong answer, and nothing else in setup depends on it." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.broker.consent",
    title: "Approve a static site's sign-in",
    routes: ["/broker/authorize"],
    guide: [
      "guide/1",
      'goal "gate.broker.consent"',
      'say "A static site asked OpenSesame to sign you in. This window is OpenSesame\'s own: the site never sees your vault, only an identity assertion you choose to release."',
      'focus "broker.consent" "The card says which site is asking and for which scopes. If you are not signed in yet it asks you to sign in first. Allow releases the assertion to that site only, Deny sends it a refusal, and Use a different account signs this one out first." side=bottom',
      'success "You can close this window when it says Done."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.federation.return",
    title: "Finish an identity-provider sign-in",
    routes: ["/federation"],
    guide: [
      "guide/1",
      'goal "gate.federation.return"',
      'say "You are back from an identity provider. This screen finishes that sign-in and sends you on. It takes a moment and needs nothing from you."',
      'focus "federation.return" "While it works it says Finishing sign-in. If the provider\'s answer cannot be used it says so here, with Back to sign-in to start again." side=bottom',
      'success "A sign-in that finished takes you back to where you started."',
      "end",
    ].join("\n"),
  },
];
