/**
 * What the device Identity host can see of this browser's vault (ADR 0160).
 *
 * The host sits on the store's import cycle (`store → remote-code → identity →
 * device-identity → …`), so it cannot ask the store. It reads the two things
 * the store already publishes outside itself: which tombs hold a key
 * (`vfs`), and the plaintext pointers that say a vault exists on this device.
 *
 * Three states, and only one of them issues anything:
 *
 * - `unlocked` — a tomb holds its key. A guest tomb is flagged, because a
 *   guest keeps a provisional principal and never reads a member's tomb.
 * - `locked` — a vault is on this device and none is open. Device routes
 *   answer `locked`; there is no plaintext fallback.
 * - `none` — no vault has ever been opened here. Nothing durable exists to
 *   derive a principal from, so only a provisional one can be minted.
 */

import { readLastVaultId } from "./last-vault.js";
import { activeProject, listProjects } from "./projects.js";
import { GUEST_TOMB, listTombs, tombUnlocked } from "./vfs.js";

export type DeviceVaultView =
  | { kind: "none" }
  | { kind: "locked" }
  | { kind: "unlocked"; tomb: string; guest: boolean };

function defaultView(): DeviceVaultView {
  const projects = listProjects().map((project) => project.id);
  const candidates = [
    ...new Set([activeProject().id, ...projects, GUEST_TOMB, ...listTombs()]),
  ];
  const open = candidates.find((tomb) => tombUnlocked(tomb));
  if (open !== undefined) {
    return {
      kind: "unlocked",
      tomb: open,
      guest: open === GUEST_TOMB || !projects.includes(open),
    };
  }
  return listTombs().length > 0 || readLastVaultId() !== null
    ? { kind: "locked" }
    : { kind: "none" };
}

/** Test seam: the view the host reads. */
export const deviceVaultSeams = { view: defaultView };

export function deviceVaultView(): DeviceVaultView {
  return deviceVaultSeams.view();
}
