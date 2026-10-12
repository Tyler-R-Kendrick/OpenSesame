/**
 * Allowing a device from the owner's sheet (ADR 0195): the vault's own
 * `manage_grants` check, then the broker's approval. A refusal is a mark on
 * the sheet and a notice in the tray, and nothing is allowed.
 */

import { allowDevice } from "@opensesame/app-core/lib/live/device-allow.js";
import type {
  Approval,
  ApproveResult,
  PendingDevice,
} from "@opensesame/app-core/lib/live/device-types.js";
import type { LiveHost } from "@opensesame/app-core/lib/live/host.js";
import { LocalDirectoryError } from "@opensesame/app-core/lib/local-directory.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useState } from "react";
import { type Standing, standingMark } from "./live-hooks.js";

const REFUSED = {
  approved: null,
  unknown: standingMark("err", "The device has left"),
  lapsed: standingMark("err", "The request lapsed"),
  nothing_chosen: standingMark("warn", "Choose a connection"),
  unavailable: standingMark("err", "Connections are not available"),
} satisfies Record<ApproveResult, Standing | null>;

/** A fault in asking the vault, which is not the vault refusing. */
const FAULT = standingMark(
  "err",
  "Could not allow the device",
  "Allowing the device failed before anything was granted. Try again.",
);

export function useAllowDevice(
  host: LiveHost,
  pending: PendingDevice,
  onAllowed: () => void,
) {
  const [said, setSaid] = useState<Standing | null>(null);
  // A new object for each failure, so the same sentence comes back to the tray.
  const [failure, setFailure] = useState<{ message: string } | null>(null);

  function refuse(mark: Standing): void {
    setSaid(mark);
    setFailure(mark.tone === "err" ? { message: mark.tray } : null);
  }

  /**
   * Allowing hands out authority, so the vault's own check runs first (its
   * operator rule and duress ceilings), as it does for any grant. What it
   * refuses with is told as it is; anything else that goes wrong is not a
   * refusal, and is not called one.
   */
  async function allow(approval: Approval): Promise<void> {
    try {
      const result = await allowDevice(
        host.devices,
        vaultStore.activeTomb(),
        pending.id,
        approval,
      );
      const refusal = REFUSED[result];
      if (refusal === null) onAllowed();
      else refuse(refusal);
    } catch (error) {
      // The vault's own refusal is told as it is; anything else is a fault.
      refuse(
        error instanceof LocalDirectoryError
          ? standingMark("err", "Not allowed here", error.message)
          : FAULT,
      );
    }
  }

  return { said, failure, allow, clear: () => setSaid(null) };
}
