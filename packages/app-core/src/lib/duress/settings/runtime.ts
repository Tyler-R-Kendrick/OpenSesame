/**
 * The module `loadDuressRuntime` warms for `duress.settings`. Nothing imports
 * it statically, so the bundler can split it; pointing that loader at a file
 * the settings UI already imports through the barrel would leave the import
 * lazy in name only.
 */

export * from "./index.js";
