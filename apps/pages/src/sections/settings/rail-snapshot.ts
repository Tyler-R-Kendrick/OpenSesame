import {
  FEATURES,
  isSwitchable,
} from "@opensesame/app-core/lib/capabilities/features.js";
import { INTEGRATIONS } from "@opensesame/app-core/lib/capabilities/integrations.js";
import { useMemo } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { useContributions } from "../../bindings/contributions.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useGuestRowShown } from "./CapabilitySwitch.js";
import { useInstallPanelShown } from "./InstallPanel.js";
import type { SettingsRailSnapshot } from "./page-tree.js";
import { useDuressPanelShown } from "./security/DuressPanel.js";
import { useAccountFactorsOffered } from "./security/account-offered.js";
import { useIntegrationsDrawn } from "./use-integrations-drawn.js";
import { useDeviceOperator } from "./useDeviceOperator.js";

/**
 * Which of Settings' conditional panels draw right now, read by the same
 * rules the page draws them by. The rail and the phone's page index both
 * start here, so neither lists a panel the page does not show.
 */
export function useSettingsPanels(): SettingsRailSnapshot {
  const install = useInstallPanelShown();
  const guests = useGuestRowShown();
  const instancePolicy = useDeviceOperator();
  const account = useAccountFactorsOffered();
  const duress = useDuressPanelShown();
  const panels = useContributions("settings-panel");
  const { plan } = useComposition();
  const identityApi = useIdentityConfigured();
  const emptyFeatures = FEATURES.filter(
    (feature) => !isSwitchable(feature, plan, { identityApi }),
  ).map((feature) => feature.id);
  const drawnIntegrations = useIntegrationsDrawn();
  const emptyIntegrations = INTEGRATIONS.filter(
    (integration) =>
      !drawnIntegrations.some((drawn) => drawn.integration === integration),
  ).map((integration) => integration.id);
  const contributed = useMemo(
    () =>
      panels.map(({ id, label, category, order }) => ({
        id,
        label,
        category,
        order,
      })),
    [panels],
  );
  return {
    install,
    guests,
    instancePolicy,
    account,
    contributed,
    duress,
    emptyFeatures,
    emptyIntegrations,
  };
}
