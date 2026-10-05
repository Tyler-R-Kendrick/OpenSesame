import { type InstallState, installWorthShowing } from "./install.js";

/**
 * Whether Settings draws its Install panel: an install to report, or one only
 * the panel offers. Chromium's `prompt` state hangs its one-gesture dialog off
 * the wordmark instead, so the panel is absent there.
 */
export function installPanelDraws(state: InstallState): boolean {
  return installWorthShowing(state) && state !== "prompt";
}
