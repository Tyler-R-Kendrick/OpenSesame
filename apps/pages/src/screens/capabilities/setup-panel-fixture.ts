/**
 * Setup panels as three module owners would register them (`setup-panel`
 * contributions, ownership §4.2). Test support: the ceremony's suites hand
 * this to `setupScreenDependencies.useSetupPanels` so the tabs after
 * `capabilities` are explicit, not whatever a loader happened to activate.
 */

import type { SetupPanel } from "../SetupScreen.js";
import { ConnectorsStep } from "../setup/steps/ConnectorsStep.js";
import { IdentityStep } from "../setup/steps/IdentityStep.js";
import { MfaStep } from "../setup/steps/MfaStep.js";

export const SETUP_PANEL_FIXTURE: readonly SetupPanel[] = [
  {
    id: "connectors",
    tab: "connectors",
    rail: "Connectors",
    Panel: ConnectorsStep,
    order: 10,
  },
  {
    id: "identity",
    tab: "identity",
    rail: "Identity",
    Panel: IdentityStep,
    order: 30,
  },
  { id: "mfa", tab: "mfa", rail: "MFA", Panel: MfaStep, order: 40 },
];
