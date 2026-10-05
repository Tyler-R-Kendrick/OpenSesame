import { DECOY_ITEMS } from "./decoy-items.js";
import { DECOY } from "./decoy.js";
import type { DuressMode } from "./mode.js";
import { WIPE } from "./wipe.js";
import { WRONG_PASSWORD } from "./wrong-password.js";

export type {
  DuressEffectName,
  DuressInputOption,
  DuressMode,
  DuressModeInput,
  DuressPlan,
  DuressPresentation,
} from "./mode.js";
export { inputReady, itemLines } from "./inputs.js";
export { decodePlan, encodePlan } from "./payload.js";
export {
  type EffectHost,
  type EffectPhase,
  hasEffectRunner,
  runDuressEffects,
} from "./effects.js";

/** Every mode the sheet offers, in the order it draws them. */
export const MODES = [DECOY, DECOY_ITEMS, WRONG_PASSWORD, WIPE] as const;

export type DuressModeId = (typeof MODES)[number]["id"];

/** The mode named `id`, or nothing: an unknown id is never guessed at. */
export function getMode(id: string): DuressMode | undefined {
  return MODES.find((mode) => mode.id === id);
}
