import type { IdentitySession } from "../identity-session-types.js";
import { loadSettings } from "../settings.js";
import {
  captureRemoteIdentityCodeData,
  type OriginalRemoteCodeHandle,
} from "./captured-remote-code-data.js";
import type { OriginalCommandDrainRecorder } from "./original-command-retirement-data.js";
/** Original bearer transport DATA only; the private Store must prove primary/all configured factors. */
export function captureOriginalIdentitySessionCodeData(
  original: () => void,
  readSession: () => IdentitySession | null,
  readEpoch: () => number,
  drainFailed?: OriginalCommandDrainRecorder,
): OriginalRemoteCodeHandle {
  const active = readSession();
  const epoch = readEpoch();
  const base = loadSettings().identityApi.replace(/\/+$/u, "");
  if (!active || active.cookieOnly || !active.accessToken || !base)
    throw new Error("Original remote identity code transport is unavailable.");
  const selected = Object.freeze({ ...active });
  const check = () => {
    original();
    if (
      readSession() !== active ||
      readEpoch() !== epoch ||
      loadSettings().identityApi.replace(/\/+$/u, "") !== base ||
      active.principalId !== selected.principalId ||
      active.accessToken !== selected.accessToken ||
      active.issuerOrigin !== selected.issuerOrigin ||
      active.cookieOnly !== selected.cookieOnly ||
      active.expiresAt !== selected.expiresAt ||
      (selected.expiresAt &&
        (!Number.isFinite(Date.parse(selected.expiresAt)) ||
          Date.parse(selected.expiresAt) <= Date.now()))
    )
      throw new Error("The original identity code transport ended.");
  };
  check();
  return captureRemoteIdentityCodeData(
    base,
    selected.accessToken,
    selected.issuerOrigin,
    check,
    drainFailed,
  );
}
