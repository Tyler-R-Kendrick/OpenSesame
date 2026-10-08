/**
 * Device connector configuration. Several capability runtimes read the same
 * saved record, so the files are shared infrastructure.
 */

import { core, each, shared } from "./classification-rule.js";

const L = "src/lib/";

export const DEVICE_CONNECTOR_RULES = [
  core(
    `${L}device-connector-legacy`,
    "vault.local-unlock",
    "owner-authenticated import or discard of quarantined legacy credentials in Security",
  ),
  shared(
    `${L}device-connector-legacy-storage`,
    "legacy quarantine schemas read by retired-credential enrollment and connector metadata",
  ),
  shared(
    `${L}device-connector-lock`,
    "fresh metadata serialization shared by connector writers and owner recovery",
  ),
  ...each(
    L,
    ["device-connector-principal", "device-connector-principal-state"],
    (p) =>
      shared(
        p,
        "admitted vault and generation binding shared by connector runtimes, Git backup and vault carry",
      ),
  ),
  ...each(
    L,
    [
      "apply-saved-connectors",
      "capability-feature-operation",
      "device-connector-records",
      "device-connectors",
      "feature-connector-operation",
      "feature-request",
      "feature-request-authority",
      "local-connector-features",
    ],
    (p) =>
      shared(p, "saved connector configuration several capabilities share"),
  ),
];
