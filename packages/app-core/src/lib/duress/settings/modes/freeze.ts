import { extendHold } from "../../hold/record.js";
import type { EffectRunner } from "./effects.js";
import type { DuressMode } from "./mode.js";

/**
 * Refused like a wrong password, and then this device refuses the vault's real
 * credentials for 1, 24 or 72 hours (ADR 0168). The hold is the device's clock
 * and its own storage: it can be lengthened but not shortened from here.
 */
export const FREEZE = {
  id: "freeze",
  label: "Freeze for a while",
  opens:
    "nothing; it reads as a wrong password, then real credentials are refused for a while",
  consent:
    "I understand that after this code is typed this device refuses my real password and other real credentials for the time I chose, that I cannot shorten it from this device, and that it relies on this device's clock.",
  presentation: "locked",
  input: {
    kind: "choice",
    id: "freeze_hours",
    label: "Refuse real credentials for",
    options: [
      { value: "1", label: "1 hour" },
      { value: "24", label: "24 hours" },
      { value: "72", label: "72 hours" },
    ],
  },
  plan: (extras) => ({
    effect: "freeze",
    body: { hours: Number(extras.freeze_hours) },
  }),
} as const satisfies DuressMode;

/**
 * Writes the hold, before the refusal is shown. A body that is not one of the
 * three durations does nothing, and a write storage refuses records nothing
 * (see `extendHold`): the code is then refused like a wrong password and the
 * device is not held.
 */
export const FREEZE_RUNNER: EffectRunner = {
  phase: "on_match",
  run: async (body) => {
    const hours =
      typeof body === "object" && body !== null && "hours" in body
        ? body.hours
        : undefined;
    await extendHold(hours);
  },
};
