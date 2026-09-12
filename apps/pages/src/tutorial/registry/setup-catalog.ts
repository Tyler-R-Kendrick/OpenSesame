import type { GuideTargetDescriptor } from "./targets.js";

/**
 * The gates: the front door and unlock screen, the setup ceremony, and the
 * broker and federation returns. Split from the main catalog so the boot path
 * has one file to read (ADR 0115).
 */
export const SETUP_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "unlock.submit",
    description:
      "The ink square that opens the vault — passkey, PIN or master password, whichever method is selected.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.secret",
    description:
      "The field that takes the master password or PIN used to unwrap the vault key on this device.",
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
      "Opens optional deployment setup — connectors, sign-in, backups, all skippable. The Set up your own road on the front door, and a link in the sign-in form's foot.",
    role: "ceremony",
    routes: ["/unlock"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.join",
    description:
      "Opens the join road: a claim invite or a request into a public session. The Join a session road on the front door, and a link in the sign-in form's foot.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.ways",
    description:
      "The allowlist of sign-in roads: brokered providers, operators' own issuers, and an optional Identity service.",
    role: "surface",
    routes: ["/setup"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.connectors",
    description:
      "The connectors tab of setup: a Nango-compatible directory endpoint and key, and the Sync that brings every connection it already holds across by reference.",
    role: "surface",
    routes: ["/setup"],
    capabilityId: "connectors.directory.sync",
  },
  {
    id: "setup.keep",
    description:
      "The offer to keep this app on the device — install the PWA, with no wrong answer if declined.",
    role: "action",
    routes: ["/setup"],
    capabilityId: "app.install",
  },
  {
    id: "setup.finish",
    description:
      "The ink square that finishes setup and returns to sign-in with the roads just chosen.",
    role: "action",
    routes: ["/setup"],
    capabilityId: "setup.first_run",
  },
  {
    id: "broker.consent",
    description:
      "The broker popup that asks a person to approve a static site receiving an upstream identity assertion.",
    role: "ceremony",
    routes: ["/broker/authorize"],
    capabilityId: "identity.login",
  },
  {
    id: "federation.return",
    description:
      "The screen that finishes an identity-provider redirect and lands back in the vault or on unlock.",
    role: "ceremony",
    routes: ["/federation"],
    capabilityId: "identity.login",
  },
];
