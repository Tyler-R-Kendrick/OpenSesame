/**
 * Curated duress presets — catalog labels only.
 * Security decisions come from CONTRACT compileDuressPolicy; presets do not
 * re-implement compiler rules.
 */

export {
  PRESET_CATALOG,
  PRESET_IDS,
  getPresetMeta,
  isPresetId,
  type PresetId,
  type PresetMeta,
  type PresetScope,
} from "./preset-catalog.js";
export { buildPresetPolicy } from "./preset-build.js";
