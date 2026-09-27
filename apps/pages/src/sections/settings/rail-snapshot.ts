import { resolveDuressMode } from "@opensesame/app-core/lib/duress/feature/mode.js";
import { useMemo } from "react";
import { useContributions } from "../../bindings/contributions.js";
import { useGuestRowShown } from "./CapabilitySwitch.js";
import { useInstallPanelShown } from "./InstallPanel.js";
import type { SettingsRailSnapshot } from "./page-tree.js";
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
  const panels = useContributions("settings-panel");
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
    duress: resolveDuressMode({}) !== "off",
  };
}
