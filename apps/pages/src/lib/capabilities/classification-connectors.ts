/**
 * Connector catalogue classification.
 *
 * Split out of `classification-lib.ts` for the 400-line module budget.
 */
import { core, each, optional, shared } from "./classification-rule.js";

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
  "secret-backends/",
  "ai-connections/",
  "tailscale/",
  // The operator-supplied OIDC client the Connections page configures.
  "custom-oidc",
];

export const CONNECTOR_LIB_RULES = [
  optional(
    `${L}test/native-s3-backup-fixtures.ts`,
    CONNECTORS,
    "test-only TLS fixture for native S3 encrypted vault backup",
  ),
  optional(
    `${L}test/native-azure-secrets-backup-fixture.ts`,
    CONNECTORS,
    "test-only Azure Key Vault fixture for native encrypted vault backup",
  ),
  shared(
    `${L}secret-backends/onepassword-artifacts.json`,
    "pinned public SDK asset metadata shared by ownership and the native worker",
  ),
  core(
    `${L}secret-backends/seam.ts`,
    null,
    "public secret backend view seam carries no runtime or credentials",
  ),
  optional(
    "src/browser/secret-backend-",
    CONNECTORS,
    "browser-only secret backend API boundaries",
  ),
  ...each(L, CONNECTOR_FILES, (p) =>
    optional(
      p,
      CONNECTORS,
      "connector catalogue, Connect, GitHub App, directory",
    ),
  ),
];
