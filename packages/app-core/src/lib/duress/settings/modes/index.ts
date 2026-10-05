import { DECOY } from "./decoy.js";
import type { DuressMode } from "./mode.js";
import { WRONG_PASSWORD } from "./wrong-password.js";

export type {
  DuressEffectName,
  DuressMode,
  DuressModeInput,
  DuressPresentation,
} from "./mode.js";

/** Every mode the sheet offers, in the order it draws them. */
export const MODES = [DECOY, WRONG_PASSWORD] as const;

export type DuressModeId = (typeof MODES)[number]["id"];

/** The mode named `id`, or nothing: an unknown id is never guessed at. */
export function getMode(id: string): DuressMode | undefined {
  return MODES.find((mode) => mode.id === id);
}
