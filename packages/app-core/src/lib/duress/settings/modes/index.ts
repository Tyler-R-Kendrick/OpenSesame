import { DECOY_ITEMS } from "./decoy-items.js";
import { DECOY } from "./decoy.js";
import { FREEZE } from "./freeze.js";
import type { DuressMode } from "./mode.js";
import { VISIBLE_ITEMS } from "./visible-items.js";
import { WIPE } from "./wipe.js";
import { WRONG_PASSWORD } from "./wrong-password.js";

export type {
  DuressContext,
  DuressEffectName,
  DuressPickRow,
  DuressInputOption,
  DuressMode,
  DuressModeInput,
  DuressPlan,
  DuressPresentation,
} from "./mode.js";
export { inputReady, isOffered, itemLines, offeredModes } from "./inputs.js";
export { decodePlan, encodePlan } from "./payload.js";
export {
  type EffectHost,
  type EffectPhase,
  hasEffectRunner,
  runDuressEffects,
} from "./effects.js";

/**
 * Every mode the sheet can offer, in the order it draws them: the ones that
 * open something a person can show come first, the refusals after. A refusal
 * leaves a compelled person with nothing to show (ADR 0168).
 */
export const MODES = [
  DECOY,
  VISIBLE_ITEMS,
  DECOY_ITEMS,
  WRONG_PASSWORD,
  FREEZE,
  WIPE,
] as const;

export type DuressModeId = (typeof MODES)[number]["id"];

/** The mode named `id`, or nothing: an unknown id is never guessed at. */
export function getMode(id: string): DuressMode | undefined {
  return MODES.find((mode) => mode.id === id);
}
