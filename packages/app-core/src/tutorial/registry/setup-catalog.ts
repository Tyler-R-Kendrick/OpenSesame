import type { GuideTargetDescriptor } from "./targets.js";

/**
 * The gates: the front door and unlock screen, the setup ceremony, and the
 * broker and federation returns. Split from the main catalog so the boot path
 * has one file to read (ADR 0115).
 */
/** The setup ceremony's tabs that have a tour; the tabs' own frame is on all of them. */
const CEREMONY = [
  "/setup/capabilities",
  "/setup/identity",
  "/setup/connectors",
];

export const SETUP_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "unlock.submit",
    description:
      "The ink square that opens the vault — passkey or PIN, or a master password an older vault still holds, whichever method is selected.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.secret",
    description:
      "The field that takes the PIN (or, on an older vault, the master password) used to unwrap the vault key on this device.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.passkey",
    description: "Chooses the passkey challenge as the way to open this vault.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.methods",
    description:
      "The tabs of unlock methods: exactly the keys this vault has enrolled — a passkey, a PIN, or a master password an older vault still holds — and on first run the two it can be sealed with.",
    role: "navigation",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.guest",
    description:
      "The guest road: Skip in the corner of the front door, and Skip to the guest vault under the unlock form beside a sealed vault. Not on the sign-in panel, and not beside a keyless guest tomb, where Unlock resumes that tomb. A guest vault is sealed on this device and kept apart from any other vault here, which it never reads.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.local-only",
    description:
      "Use without an account, on first run: seals a vault on this device with a passkey or PIN and no account, so there is no sync and no account recovery.",
    role: "action",
    routes: ["/unlock/signin"],
    capabilityId: null,
  },
  {
    id: "unlock.account",
    description:
      "The user menu on the right of the unlock screen: who locked this vault, the other vaults on this device, Sign in to swap identity, and Sign out.",
    role: "status",
    routes: ["/unlock"],
    capabilityId: "identity.signout",
  },
  {
    id: "unlock.signin",
    description:
      "The sign-in panel: identity providers configured for this deployment, plus the option to bring your own issuer.",
    role: "ceremony",
    routes: ["/unlock"],
    capabilityId: "identity.login",
  },
  {
    id: "vaults.list",
    description:
      "The list of vaults on this device — the personal vault, each project vault, and the guest road — where pressing a row switches to it.",
    role: "surface",
    routes: ["/unlock", "/settings/vaults"],
    capabilityId: "vaults.switch",
  },
  {
    id: "prompt.tomb",
    description:
      "The vault segment of the shell prompt (who@vault:/); opens the list of vaults on this device to switch between them.",
    role: "action",
    routes: [],
    capabilityId: "vaults.switch",
  },
  {
    id: "unlock.setup",
    description:
      "Opens optional deployment setup — connectors, sign-in, backups, all skippable. The Set up your own road on the front door; after the ceremony, setup lives behind unlock.",
    role: "ceremony",
    routes: ["/unlock"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.join",
    description:
      "The front door's Join a session road: join somebody's live session from the link they shared (plus the code, for an invite), browser to browser by trading request and reply codes (by hand, or through a carrier the owner named), or accept a Host invite. A shared link opens it by itself.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.configurations",
    description:
      "The four ways to set this device up — Minimal, Default, Full and Custom — with Skip all beneath them. Custom opens the tabbed ceremony.",
    role: "surface",
    routes: ["/setup/choose"],
    capabilityId: null,
  },
  {
    id: "setup.tabs",
    description:
      "The tabs of the setup ceremony, one for each concern and each skippable. The first is what this installation runs; the rest belong to features that are on.",
    role: "navigation",
    routes: CEREMONY,
    capabilityId: null,
  },
  {
    id: "setup.ways",
    description:
      "The allowlist of sign-in roads: brokered providers, operators' own issuers, and an optional Identity service.",
    role: "surface",
    routes: ["/setup/identity"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.connectors",
    description:
      "The connectors tab of setup: a Nango-compatible directory endpoint and key, and the Sync that brings every connection it already holds across by reference.",
    role: "surface",
    routes: ["/setup/connectors"],
    capabilityId: "connectors.directory.sync",
  },
  {
    id: "setup.keep",
    description:
      "The offer to keep this app on the device — install the PWA, with no wrong answer if declined.",
    role: "action",
    routes: CEREMONY,
    capabilityId: "app.install",
  },
  {
    id: "setup.finish",
    description:
      "The ink square that finishes setup and returns to sign-in with the roads just chosen.",
    role: "action",
    routes: CEREMONY,
    capabilityId: "setup.first_run",
  },
  {
    id: "broker.consent",
    description:
      "The card of the broker popup that asks a person to approve a static site receiving an upstream identity assertion, or says why it cannot.",
    role: "ceremony",
    routes: ["/broker/authorize"],
    capabilityId: "identity.login",
  },
  {
    id: "federation.return",
    description:
      "What the screen that finishes an identity-provider redirect says: Finishing sign-in while it works, or why it could not, with Back to sign-in. It lands back in the vault or on unlock.",
    role: "ceremony",
    routes: ["/federation"],
    capabilityId: "identity.login",
  },
];
