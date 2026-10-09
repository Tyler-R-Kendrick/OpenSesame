/**
 * Code two or more optional capabilities import.
 *
 * Connections, Access and Identity are separate optional extensions (ADR 0153),
 * each with its own switch, yet the Access section is built over the local
 * directory and the connector catalogue (its Connectors tab, its Policies and
 * Requests forms, vault sessions), and the setup ceremony and the Identity
 * federation tab draw connector and local-application pieces. A file that more
 * than one optional capability reaches belongs to none of them: classified as
 * `optional` it either mixed capabilities in one chunk (BUILD-05) or, in a
 * hardened build that kept one capability and excluded the other, was emitted
 * under the excluded one's name (BUILD-04).
 *
 * These are `shared`: present wherever something reachable imports them, owning
 * no feature, and closed — nothing listed here imports optional feature code
 * that is not listed here. The capability's own section, route and runtime
 * module stay `optional`; only what both sides reach lives here. A file reached
 * by exactly one capability does not belong in this list.
 *
 * Rules here are matched before the area files', so a name listed here wins a
 * tie with the same prefix in `classification-lib.ts` or `-sections.ts`.
 */

import { optional, shared } from "./classification-rule.js";

const L = "src/lib/";
const S = "src/sections/identity/";
const NM = "node_modules/";

/** Local directory, sessions and application records Access reads. */
const LOCAL_RECORDS = [
  // Identity › Applications edits OAuth clients through it; federation does too.
  "oauth-client-admin",
  // The receipts a device writes for its person and the inbox of what waits
  // for them (ADR 0162): Access, Browser-local IAM, Self-issued OpenID and
  // local notifications each write or read one.
  "device-inbox",
  "device-receipts",
  "local-access-audit",
  "local-access-ledger-lock",
  "local-agent-auth",
  "local-agent-keys",
  "local-application-shape",
  "local-applications",
  "local-credentials",
  // The request as a list shows it, and the sign-in being decided in its own
  // window: Access and the device inbox both read it.
  "local-request-summary",
  "local-devices",
  "local-directory",
  "local-directory-bootstrap",
  "local-directory-memberships",
  "local-directory-types",
  "local-organizations",
  "local-passkey-prf",
  "local-passkeys",
  "local-rbac",
  "local-request-store",
  "local-sessions",
  "local-share-grants",
  // Who may write a share (ADR 0178): the proofs local-share-grants takes.
  "proofs/share-write",
  // Core vault workflows and WebMCP enforce standing shares even while the
  // optional Access administration surface is absent.
  "local-share-reach",
  "local-vault-session-issue",
  "local-vault-sessions",
  "pages-dogfood",
  "standing-connection-grants",
];

/** The Identity panels the Access and federation surfaces draw. */
const IDENTITY_PIECES = [
  "ApplicationDiagnostics",
  "ApplicationRecipePanel",
  "ApplicationSetupCard",
  // Shared record chrome and the directory's publication seam: hosted
  // provisioning publishes here; the local Identity tree only reads it.
  "HostedRecordParts",
  "hosted-identity-rail",
  "LocalAgentAuthentication",
  "LocalAgentEnrollment",
  "LocalAgentKeys",
  "LocalApplicationFields",
  "LocalApplicationSettings",
  "LocalIdentitySession",
  "LocalMemberOrganizationRows",
  "LocalMemberOrganizations",
  "RegistrationActions",
  "RegistrationExtras",
  "registration-draft",
  "application-recipe-panel-model",
  "member-organizations-model",
  // The registry every capability contributes an Identity tab through.
  "directory-panel-slot",
  "identity-views",
  // Where networking.tailnet-devices puts the tailnet's machines (ADR 0169).
  "tailnet-devices-slot",
];

/** The connector catalogue Access, setup and device connectors read. */
const CONNECTOR_RECORDS = [
  "connect-create",
  "connect-plan",
  "connect-presets.generated",
  "connect-provider-auth-schema",
  "connect-update",
  "connections",
  "connections-integrations",
  "connections-local-git",
  "connector-directory",
  "connector-settings",
  "nango-directory",
  "vercel-connect",
  "vercel-connect-catalog",
  "vercel-connect-manage",
  "vercel-connect-map",
  "vercel-connect-ops",
  "vercel-connect-relay",
];

export const CROSS_RULES = [
  shared(
    `${L}model-provider-record`,
    "model selections shared by local and remote AI without provider implementations",
  ),
  shared(
    `${L}hosted-model-authority`,
    "provider authority port shared by model selection and optional provider runtimes",
  ),
  ...[
    "hosted-inference",
    "saved-model-agent",
    "hosted-model-protocol",
    "hosted-model.test-support",
  ].map((name) =>
    optional(
      `${L}${name}`,
      "support.remote-ai",
      "closed hosted model protocols and their test fixtures",
    ),
  ),
  optional(
    `${L}native-`,
    "connectors.external",
    "native provider authorization and connection runtime",
  ),
  shared(
    `${L}generated-json`,
    "public JSON fragment codec shared by the connector catalogue and browser admission metadata",
  ),
  ...LOCAL_RECORDS.map((name) =>
    shared(`${L}${name}`, "local directory records Access and Identity share"),
  ),
  ...IDENTITY_PIECES.map((name) =>
    shared(`${S}${name}`, "Identity pieces Access and federation also draw"),
  ),
  ...CONNECTOR_RECORDS.map((name) =>
    shared(`${L}${name}`, "connector catalogue Access and setup also read"),
  ),
  shared(
    "src/screens/setup/steps/ConnectorCards",
    "setup's connector cards, drawn by the federation steps as well",
  ),
  shared(
    `${NM}@vercel/connect`,
    "reached through lib/vercel-connect.ts, which Access also reads",
  ),
  shared(
    `${NM}@opensesame/auth-upstream`,
    "browser passkey helpers the local records import",
  ),
];
