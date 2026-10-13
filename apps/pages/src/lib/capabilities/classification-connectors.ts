/**
 * Connector catalogue classification.
 *
 * Split out of `classification-lib.ts` for the 400-line module budget.
 */
import { each, optional } from "./classification-rule.js";

const L = "src/lib/";
const CONNECTORS = "connectors.external";

const CONNECTOR_FILES = [
  "linear-",
  "connector-guidance",
  "connector-bridge", // the page's side of the connector bridge (ADR 0199)
  "use-native-bridge",
  "connect-",
  "self-hosted-config",
  "self-hosted-connectors",
  "github-installation-access",
  "identity-graph",
];

export const CONNECTOR_LIB_RULES = each(L, CONNECTOR_FILES, (p) =>
  optional(p, CONNECTORS, "connector catalogue, Connect, GitHub App, directory"),
);
