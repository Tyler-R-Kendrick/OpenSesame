/** Particle-plate wordmark: model, layout, and draw surface. */
export {
  ALPHA_LEVELS,
  DRAW_CALIBRATION,
  FONT_FAMILY,
  PARTICLE_SEED,
  SOLID_MAX_EM,
  TAU,
  TYPE_MAX_EM,
  WORDMARK_WIDTH_EM,
  type DrawCalibration,
  type Layout,
  type Particle,
  type WordSlot,
  type WordmarkTier,
  cursorBoostFor,
  inkAlpha,
  isDarkInk,
  lcg,
  particleField,
  readInkRgb,
  readSlit,
  tierOf,
} from "./particles-model.js";
export { layoutWordmark } from "./particles-layout.js";
export { drawWordmark, type DrawWordmarkOpts } from "./particles-draw.js";
