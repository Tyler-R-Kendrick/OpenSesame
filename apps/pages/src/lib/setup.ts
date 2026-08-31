/**
 * First-run setup — the record that this deployment has an operator.
 *
 * A static Pages deploy arrives with no Identity API, no Host, and no daemon,
 * and the first person to open it is the only one who can say what those
 * should be. The screen used to tell them so with a warning: a block of amber
 * above an unlock form, naming a service they had never heard of and offering
 * a text field for an address nobody had given them. That is a report, not a
 * road — and it sat above sign-in options that could not work and an Unlock tab
 * for a vault that did not exist.
 *
 * So the first visitor is treated as the operator, and asked. This module holds
 * the small thing that ceremony leaves behind: whether it has been answered,
 * and what was answered. It stores no addresses of its own — those belong to
 * `lib/settings.ts` and are written there — only the fact of the decision, so
 * the app can tell "nobody has set this up" apart from "the operator
 * deliberately runs this without a Host".
 *
 * The record is plaintext beside the vault, never inside it: the ceremony runs
 * before any vault exists, so there is nothing to seal it with.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvGet, kvSetDurable } from "./kv.js";
import { loadSettings } from "./settings.js";

export const SETUP_KEY = "setup.v1";

/** Which road the operator took on the identity step. */
export type SetupIdentityChoice = "connected" | "local-only";

export type SetupRecord = {
  /** When the ceremony was answered — ISO 8601, for the Review readout. */
  completedAt: string;
  identity: SetupIdentityChoice;
  /**
   * The upstream provider preset registered during setup ("workos", "okta",
   * "auth0", "better-auth", "oidc"), or "" when none was added. Never a secret:
   * registration itself happens server-side through the Identity API.
   */
  provider: string;
  /** True when a Host API was pointed at. */
  host: boolean;
  /** True when a daemon on this machine (or tailnet) was paired. */
  machine: boolean;
};

function readChoice(value: BoundaryValue | undefined): SetupIdentityChoice {
  return value === "local-only" ? "local-only" : "connected";
}

function loadSetupDefault(): SetupRecord | null {
  try {
    const raw = kvGet(SETUP_KEY);
    if (!raw) return null;
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return null;
    if (!isString(parsed.completedAt) || !parsed.completedAt) return null;
    return {
      completedAt: parsed.completedAt,
      identity: readChoice(parsed.identity),
      provider: isString(parsed.provider) ? parsed.provider : "",
      host: parsed.host === true,
      machine: parsed.machine === true,
    };
  } catch {
    // A corrupt record is the same as no record: the ceremony runs again,
    // which is a survivable outcome. Refusing to boot is not.
    return null;
  }
}

/** What the app already knows about this device when setup is considered. */
export type SetupContext = {
  /** The vault store's status: "empty" means nothing has ever been sealed. */
  vaultStatus: "empty" | "locked" | "unlocked";
  /** True when an Identity session is live in this tab. */
  hasSession: boolean;
};

async function completeSetupDefault(
  outcome: Omit<SetupRecord, "completedAt">,
): Promise<void> {
  const record: SetupRecord = {
    completedAt: new Date().toISOString(),
    ...outcome,
  };
  // Durable: losing this write means asking the operator the same four
  // questions again on the next reload, which reads as the app forgetting them.
  // Where OPFS is absent altogether `kvSetDurable` resolves anyway, and the
  // unlock screen already says that nothing survives the tab in that browser.
  await kvSetDurable(SETUP_KEY, JSON.stringify(record));
}

export const setupSeams = {
  loadSetup: loadSetupDefault,
  completeSetup: completeSetupDefault,
  loadSettings,
};

export function loadSetup(): SetupRecord | null {
  return setupSeams.loadSetup();
}

export async function completeSetup(
  outcome: Omit<SetupRecord, "completedAt">,
): Promise<void> {
  return setupSeams.completeSetup(outcome);
}

/**
 * Whether the setup ceremony must run before anything else is shown.
 *
 * Three ways to have been here before, and any one of them is enough:
 *
 *  - the ceremony was answered (the record);
 *  - a vault was sealed on this device, which every build before this one let
 *    you do without a ceremony — dropping those people into setup would be
 *    telling a returning user their vault is a fresh install;
 *  - an Identity session is live, which is only reachable through a working
 *    Identity API, so somebody has already pointed this app at one.
 */
export function setupRequired(context: SetupContext): boolean {
  if (loadSetup() !== null) return false;
  if (context.vaultStatus !== "empty") return false;
  return !context.hasSession;
}

/**
 * Whether "Unlock" is an action this device can actually perform.
 *
 * Only a sealed vault can be unlocked. With nothing on the device the tab is a
 * promise the app cannot keep — the old screen offered it anyway, beside a
 * passkey button that could only ever fail. It is withheld rather than
 * disabled: a greyed control still asserts the action exists and merely is not
 * available *right now*, which is a different and untrue claim.
 */
export function unlockViable(
  vaultStatus: SetupContext["vaultStatus"],
): boolean {
  return vaultStatus !== "empty";
}

/** The four steps, in the order the ceremony asks them. */
export const SETUP_STEPS = ["identity", "host", "machine", "review"] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Which step to open on.
 *
 * A deployment that already carries endpoints — loopback dev, or a static
 * deploy whose `os-runtime-config.json` names them — has answered the first two
 * questions before anyone arrived. Marching such an operator through four
 * screens of pre-filled fields would teach them the ceremony is theatre, so it
 * opens on Review and they confirm. Everyone else starts at the beginning.
 */
export function initialStep(): SetupStep {
  const settings = setupSeams.loadSettings();
  if (!settings.identityApi.trim()) return "identity";
  if (!settings.hostApi.trim()) return "host";
  return "review";
}
