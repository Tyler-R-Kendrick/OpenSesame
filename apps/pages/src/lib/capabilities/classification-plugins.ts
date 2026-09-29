/**
 * The runtime-installed plugins' Settings code (ADR 0150 §7). Two optional
 * capabilities draw the same tile over the same daemon calls, so what they
 * share is `shared`: it imports no optional code, and reaches a page only
 * through one of the two modules (`src/modules/<id>/`, owned by its id).
 * The daemon port itself is the tailnet capability's
 * (`src/lib/tailnet-sync/plugin-daemon`, under `networking.tailnet`), which
 * both depend on.
 */

import { shared } from "./classification-rule.js";

export const PLUGIN_RULES = [
  shared(
    "src/lib/plugins/",
    "plugin catalog mirror, daemon wire reader, client and session (ADR 0150)",
  ),
  shared(
    "src/sections/settings/plugin-files",
    "a plugin's read-only Settings file (ADR 0134, ADR 0150)",
  ),
  shared(
    "src/sections/settings/plugins/",
    "the plugin tile both plugin capabilities draw (ADR 0150)",
  ),
  shared(
    "src/modules/plugin-activation",
    "what a plugin capability contributes on activation (ADR 0150)",
  ),
];
