/**
 * Deployment setup — the record that an operator has answered for this
 * deployment.
 *
 * A static Pages deploy arrives with no Identity API, no Host, and no daemon,
 * and is complete that way (ADR 0090): the compiled-in broker signs people in
 * from the browser, guest seals a local vault, and nothing here is asked of a
 * first visitor. The ceremony this module records is *optional* — reached
 * from the sign-in screen's foot by the person who runs a deployment and
 * wants to say who signs people in. It is never a gate in front of sign-in;
 * the screen that once treated every first visitor as the operator (ADR 0077
 * §1) is superseded.
 *
 * This module holds the small thing that ceremony leaves behind: whether it
 * has been answered, and which road was taken. It stores no addresses of its
 * own — the issuer, the client id and every endpoint belong to
 * `lib/settings.ts` and are written there — only the fact of the decision, so
 * the app can tell "nobody has set this up" apart from "the operator
 * deliberately runs this with no accounts at all".
 *
 * What it deliberately does not record is infrastructure. A Host API and a
 * paired machine were once two of four setup questions; neither is a question
 * a first-time visitor has, and neither gates anything the vault does on its
 * own (ADR 0078 §4). They live in Settings → Endpoints, where an operator who
 * runs them goes looking anyway.
 *
 * The record is plaintext beside the vault, never inside it: the ceremony can
 * run before any vault exists, so there is nothing to seal it with.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { defaultUpstream } from "./federation.js";
import { kvGet, kvSetDurable } from "./kv.js";

export const SETUP_KEY = "setup.v1";

export type SetupRecord = {
  /** When the ceremony was answered — ISO 8601. */
  completedAt: string;
  /**
   * Which ways in were kept: `"builtin"` for the compiled-in broker, then one
   * preset id per provider the operator added ("google", "microsoft", "okta",
   * "oidc", …). Empty means a deployment with no accounts at all — a local
   * vault, which is a decision rather than a gap.
   *
   * The issuers and client ids themselves live in `settings.signIn`, which is
   * what actually signs people in and what the sign-in screen renders from.
   * This is only so a later screen can name the roads that were taken.
   */
  ways: string[];
  /** True when an OpenSesame identity service was named. */
  service: boolean;
  /**
   * True when this device joined an existing session rather than answering
   * "who signs people in" as the operator. The record still exists so a reload
   * does not treat the visitor as a first operator again.
   */
  joined: boolean;
};

function readWays(value: BoundaryValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const ways: string[] = [];
  for (const entry of value) if (isString(entry) && entry) ways.push(entry);
  return ways;
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
      ways: readWays(parsed.ways),
      service: parsed.service === true,
      joined: parsed.joined === true,
    };
  } catch {
    // A corrupt record is the same as no record: the ceremony runs again,
    // which is a survivable outcome. Refusing to boot is not.
    return null;
  }
}

/** The vault store's status: "empty" means nothing has ever been sealed. */
export type VaultStatus = "empty" | "locked" | "unlocked";

async function completeSetupDefault(
  outcome: Omit<SetupRecord, "completedAt" | "joined"> & { joined?: boolean },
): Promise<void> {
  const record: SetupRecord = {
    completedAt: new Date().toISOString(),
    joined: false,
    ...outcome,
  };
  // Durable: losing this write means asking the operator the same question
  // again on the next reload, which reads as the app forgetting them.
  // Where OPFS is absent altogether `kvSetDurable` resolves anyway, and the
  // unlock screen already says that nothing survives the tab in that browser.
  await kvSetDurable(SETUP_KEY, JSON.stringify(record));
}

export const setupSeams = {
  loadSetup: loadSetupDefault,
  completeSetup: completeSetupDefault,
  defaultUpstreamIssuer: () => defaultUpstream().issuer,
};

export function loadSetup(): SetupRecord | null {
  return setupSeams.loadSetup();
}

export async function completeSetup(
  outcome: Omit<SetupRecord, "completedAt" | "joined"> & { joined?: boolean },
): Promise<void> {
  return setupSeams.completeSetup(outcome);
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
export function unlockViable(vaultStatus: VaultStatus): boolean {
  return vaultStatus !== "empty";
}

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
