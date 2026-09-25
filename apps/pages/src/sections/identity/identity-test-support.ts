/**
 * Test-only: put Identity tabs on the page with the directory's panels behind
 * them, as the two runtimes do between them. Returns one revoke.
 */

import { contributeDirectoryPanels } from "./directory-panel-slot.js";
import { DIRECTORY_PANELS } from "./directory-panels.js";
import {
  type IdentityView,
  contributeIdentityViews,
} from "./identity-views.js";

export function contributeIdentityForTests(
  views: readonly IdentityView[],
): () => void {
  const revokeViews = contributeIdentityViews(views);
  const revokePanels = contributeDirectoryPanels(DIRECTORY_PANELS);
  return () => {
    revokeViews();
    revokePanels();
  };
}
