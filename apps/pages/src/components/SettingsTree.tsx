import { settingsPageTree } from "../sections/settings/page-tree.js";
import { PageTreeBranch } from "./PageTreeBranch.js";

import { useDeviceVaults } from "../bindings/vaults.js";
import { useShowHidden } from "../lib/use-show-hidden.js";
/**
 * Settings in the rail: one row per tab the page renders, then the headings
 * on that tab. Hierarchy comes from settingsPageTree — never a parallel list.
 */
export function SettingsTree({ current }: { current: string }) {
  const vaults = useDeviceVaults();
  const showHidden = useShowHidden();
  const tabs = settingsPageTree({
    vaults: vaults.map((vault) => ({ id: vault.id, label: vault.label })),
    showHidden,
  });
  return (
    <div className="railtree__kids">
      {tabs.map((node) => (
        <PageTreeBranch key={node.id} node={node} level={2} current={current} />
      ))}
    </div>
  );
}
