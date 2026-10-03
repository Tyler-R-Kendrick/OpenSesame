import { FEATURES } from "@opensesame/app-core/lib/capabilities/features.js";
import { useMemo } from "react";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { useContributions } from "../../bindings/contributions.js";
import { useGuestRowShown } from "./CapabilitySwitch.js";
import { useInstallPanelShown } from "./InstallPanel.js";
import type { SettingsRailSnapshot } from "./page-tree.js";
import { featureDraws } from "./provider-tile-items.js";
import { useDuressPanelShown } from "./security/DuressPanel.js";
import { useAccountFactorsOffered } from "./security/account-offered.js";
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
  const roads = useConnectorRoads();
  const emptyFeatures = FEATURES.filter(
    (feature) => !featureDraws(feature, roads.tile),
  ).map((feature) => feature.id);
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
  };
}
