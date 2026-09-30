/**
 * Device connector configuration. Several capability runtimes read the same
 * saved record, so the files are shared infrastructure.
 */

import { each, shared } from "./classification-rule.js";

const L = "src/lib/";

export const DEVICE_CONNECTOR_RULES = [
  ...each(
    L,
    [
      "apply-saved-connectors",
      "capability-feature-operation",
      "device-connectors",
      "feature-connector-operation",
      "local-connector-features",
    ],
    (p) =>
      shared(p, "saved connector configuration several capabilities share"),
  ),
];
