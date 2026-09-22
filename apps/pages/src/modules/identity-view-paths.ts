/**
 * Identity tab destinations, contributed by the capability that owns the tab.
 *
 * The Identity section is one component hosted by `identity.local-iam`, but
 * its tabs belong to three capabilities (`sections/identity/identity-views.ts`).
 * A `command-path` is what the command bar and the WebMCP navigation tool are
 * allowed to open, so each tab's destination has to arrive from the same
 * runtime that puts the tab on the page: with `enterprise.directory-provisioning`
 * excluded there is no Devices tab, and `/identity?view=devices` is therefore
 * not somewhere to go.
 */

import { IDENTITY_LABELS } from "../lib/section-views.js";
import type { IdentityView } from "../sections/identity/identity-views.js";
import type { Activation } from "./activation.js";

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
