/** Particle-plate wordmark: model, layout, and draw surface. */
export {
  ALPHA_LEVELS,
  DRAW_CALIBRATION,
  FONT_FAMILY,
  PARTICLE_SEED,
  SMALL_GLYPH_PX,
  TAU,
  type DrawCalibration,
  type Layout,
  type Particle,
  type WordSlot,
  cursorBoostFor,
  inkAlpha,
  isDarkInk,
  lcg,
  particleField,
  readAccent,
  readInkRgb,
} from "./particles-model.js";
export { layoutWordmark } from "./particles-layout.js";
export { drawWordmark, type DrawWordmarkOpts } from "./particles-draw.js";
