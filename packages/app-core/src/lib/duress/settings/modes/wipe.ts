import type { DuressMode } from "./mode.js";

/**
 * Refused like a wrong password, and this browser's copy of the vaults is
 * removed first. The sentences say what the removal is and is not (ADR 0168):
 * the browser's storage, not the disk; restorable only from a backup; and a
 * refusal whose timing may differ from an ordinary one's, in either direction.
 * The typed word is the one act in this sheet that
 * cannot be undone from the device.
 */
export const WIPE = {
  id: "wipe",
  label: "Wipe this device's copy",
  opens:
    "nothing; it reads as a wrong password, after removing the vaults stored in this browser",
  vault: "removed from this browser; restorable only from a backup",
  consent:
    "I understand this removes the vaults stored in this browser. They can be restored only from a backup I made. It removes what this browser stores, not what the disk may still hold, and how long the refusal takes may differ from a wrong password's.",
  presentation: "locked",
  input: {
    kind: "confirm",
    id: "confirm",
    label: "Type WIPE to confirm",
    word: "WIPE",
  },
  plan: () => ({ effect: "wipe", body: { v: 1 } }),
} as const satisfies DuressMode;
