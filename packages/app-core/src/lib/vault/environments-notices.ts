/**
 * What environments tell a person in the tray (ADR 0189): a required key with
 * no value in some environment, and a value production shares with another
 * environment.
 *
 * Both are standing conditions, mirrored into the tray by id the way a Host
 * that is down is, and both name keys and environments only, never a value
 * (ADR 0157). They are owned by the capability's background job
 * (`vault.environments/runtime.ts`), not by any panel, so they exist whenever
 * the vault is unlocked and the capability is on, and clear the moment the
 * condition does.
 */

import { dismissNotice, setStatusNotice } from "../notices.js";
import {
  ENVIRONMENTS_CAPABILITY,
  ENVIRONMENTS_PATH,
  type SchemaKey,
  missingEnvironmentValues,
  reusedProductionKeys,
} from "./environments.js";

export const ENVIRONMENT_NOTICE_ID = `${ENVIRONMENTS_CAPABILITY}.missing`;

/** Same secret value in production and another environment. */
export const ENVIRONMENT_REUSE_NOTICE_ID = `${ENVIRONMENTS_CAPABILITY}.reuse`;

const OPEN = { to: ENVIRONMENTS_PATH, label: "Open environments" } as const;
const LISTED = 4;

function listed(keys: readonly string[]): string {
  const shown = keys.slice(0, LISTED).join(", ");
  return keys.length > LISTED ? `${shown} +${keys.length - LISTED}` : shown;
}

/** Bring both notices in line with the vault as it is now. */
export function syncEnvironmentNotices(
  names: readonly string[],
  keys: readonly SchemaKey[],
): void {
  const missing = missingEnvironmentValues(names, keys);
  if (missing.length === 0) {
    dismissNotice(ENVIRONMENT_NOTICE_ID);
  } else {
    setStatusNotice({
      id: ENVIRONMENT_NOTICE_ID,
      tone: "warn",
      title: "Environment values missing",
      body: missing
        .map(({ environment, keys: gaps }) => `${environment}: ${listed(gaps)}`)
        .join(" · "),
      open: OPEN,
    });
  }
  const reused = reusedProductionKeys(names, keys);
  if (reused.length === 0) {
    dismissNotice(ENVIRONMENT_REUSE_NOTICE_ID);
  } else {
    setStatusNotice({
      id: ENVIRONMENT_REUSE_NOTICE_ID,
      tone: "warn",
      title: "Production shares a value",
      body: listed(reused),
      open: OPEN,
    });
  }
}

export function clearEnvironmentNotices(): void {
  dismissNotice(ENVIRONMENT_NOTICE_ID);
  dismissNotice(ENVIRONMENT_REUSE_NOTICE_ID);
}
