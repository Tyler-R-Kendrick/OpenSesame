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
import { defaultUpstream } from "./federation.js";
import { kvGet, kvSetDurable } from "./kv.js";
import { loadSettings } from "./settings.js";

export const SETUP_KEY = "setup.v1";

/**
 * How people sign in to this deployment — the first and often only question.
 *
 *  - `brokered`  what this build already brokers, out of the box. No identity
 *                service, no address to type, nothing to run. This is the
 *                default, and on the public web it is a working sign-in the
 *                moment the page loads.
 *  - `byo`       an identity provider the operator brings — WorkOS, Okta,
 *                Auth0, Better Auth, any other OIDC issuer. A browser cannot
 *                speak those legs itself, so this road (and only this road)
 *                needs an OpenSesame identity service to run them.
 *  - `none`      no accounts at all: a local vault, sealed on this device.
 */
export type SetupIdentityChoice = "brokered" | "byo" | "none";

export type SetupRecord = {
  /** When the ceremony was answered — ISO 8601, for the Review readout. */
  completedAt: string;
  identity: SetupIdentityChoice;
  /**
   * The provider preset registered during setup ("workos", "okta", "auth0",
   * "better-auth", "oidc"), or "" when the deployment kept what it brokers.
   * Never a secret: registration happens server-side through the identity
   * service.
   */
  provider: string;
  /** True when a Host API was pointed at. */
  host: boolean;
  /** True when a daemon on this machine (or tailnet) was paired. */
  machine: boolean;
};

function readChoice(value: BoundaryValue | undefined): SetupIdentityChoice {
  if (value === "byo" || value === "none") return value;
  return "brokered";
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
  defaultUpstreamIssuer: () => defaultUpstream().issuer,
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

/**
 * Two steps, in the order they matter.
 *
 * It was four, and three of them asked for addresses that most deployments do
 * not have and do not need — an OpenSesame identity service, a Host, a daemon
 * on the operator's own machine. Leading with self-hosted infrastructure made
 * the common case (someone who just wants to sign in and use the thing) walk
 * past three fields they had no answer for.
 *
 * So: sign-in first, because it is the only question with a wrong answer, and
 * everything else folded into one optional screen behind it.
 */
export const SETUP_STEPS = ["signin", "more"] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Whether this deployment can already sign somebody in with nothing typed.
 *
 * True wherever the build compiles a browser-capable upstream — which is
 * everywhere: `TRUSTED_UPSTREAMS` carries the public broker on the open web and
 * the reference IdP on loopback, and neither needs an identity service. It is
 * the reason the sign-in step opens with a working default selected rather than
 * an empty URL field.
 */
export function brokeredSignInReady(): boolean {
  return setupSeams.defaultUpstreamIssuer().trim().length > 0;
}
