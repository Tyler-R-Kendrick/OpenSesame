/**
 * The capture verbs kept outside `capture-evidence.mjs`: menus and settings
 * files, the ceremonies a link opens, and places the two builds draw
 * differently. `press` is that script's tap-or-click, so a phone capture taps.
 */
import { approvalSteps } from "./capture-approval-steps.mjs";
import { ceremonySteps } from "./capture-ceremony-steps.mjs";
import { invokeSteps } from "./capture-invoke-steps.mjs";
import { menuSteps } from "./capture-menu-steps.mjs";
import { placeSteps } from "./capture-place-steps.mjs";

export function extraSteps({ press }) {
  return {
    ...menuSteps({ press }),
    ...ceremonySteps({ press }),
    ...approvalSteps(),
    ...invokeSteps(),
    ...placeSteps(),
  };
}
