/**
 * The capture verbs kept outside `capture-evidence.mjs`: menus and settings
 * files, the ceremonies a link opens, and places the two builds draw
 * differently. `press` is that script's tap-or-click, so a phone capture taps.
 */
import { approvalSteps } from "./capture-approval-steps.mjs";
import { ceremonySteps } from "./capture-ceremony-steps.mjs";
import { factorSteps } from "./capture-factor-steps.mjs";
import { invokeSteps } from "./capture-invoke-steps.mjs";
import { markSteps } from "./capture-mark-steps.mjs";
import { menuSteps } from "./capture-menu-steps.mjs";
import { orgSignInSteps } from "./capture-org-signin-steps.mjs";
import { placeSteps } from "./capture-place-steps.mjs";
import { routingSteps } from "./capture-routing-steps.mjs";

export function extraSteps({ press }) {
  return {
    ...menuSteps({ press }),
    ...ceremonySteps({ press }),
    ...approvalSteps(),
    ...factorSteps({ press }),
    ...invokeSteps(),
    ...markSteps({ press }),
    ...placeSteps(),
    ...routingSteps(),
    ...orgSignInSteps(),
  };
}
