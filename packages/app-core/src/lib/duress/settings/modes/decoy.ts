import type { DuressMode } from "./mode.js";

/** An empty vault that reads as a normal unlock. */
export const DECOY = {
  id: "decoy",
  label: "Decoy vault",
  opens: "an empty decoy vault, like a normal unlock",
  consent: "I understand this code opens a decoy, never my vault.",
  presentation: "decoy",
  input: { kind: "none" },
} as const satisfies DuressMode;
