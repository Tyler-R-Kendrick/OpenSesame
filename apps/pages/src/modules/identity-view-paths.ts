/**
 * Identity tab destinations, contributed by the capability that owns the tab.
 *
 * The Identity section is one component hosted by `identity.local-iam`, but
 * its tabs belong to three capabilities (`sections/identity/identity-views.ts`).
 * A `command-path` is what the command bar and the WebMCP navigation tool are
 * allowed to open, so each tab's destination has to arrive from the same
 * runtime that puts the tab on the page: with `enterprise.directory-provisioning`
 * excluded there is no People tab, and `/identity?view=people` is therefore
 * not somewhere to go. A tab two capabilities draw in contributes a
 * destination from each, and the registry keeps it while either is live.
 */

import type { IdentityView } from "../sections/identity/identity-views.js";
import type { Activation } from "./activation.js";

import { IDENTITY_LABELS } from "../lib/section-view-names.js";
/** One `command-path` per tab, in the order the capability names them. */
export function registerIdentityViewPaths(
  activation: Activation,
  views: readonly IdentityView[],
): void {
  for (const view of views) {
    activation.register("command-path", {
      path: `/identity?view=${view}`,
      label: `Identity · ${IDENTITY_LABELS[view]}`,
    });
  }
}
