import { settingsPath } from "../lib/crumbs.js";
import { getBundledProviders } from "../lib/embedded-catalog.js";
import { settingsTabs } from "../sections/SettingsSection.js";
import { featureBindingSections } from "../sections/connections/page-tree.js";
import { PageTreeBranch, PageTreeLeafRow } from "./PageTreeBranch.js";

/** Settings in the rail: one row per tab the page actually renders. */
export function SettingsTree({ current }: { current: string }) {
  return (
    <div className="railtree__kids">
      {settingsTabs.map((tab) =>
        tab.id === "connections" ? (
          <PageTreeBranch
            key={tab.id}
            node={{
              id: tab.id,
              label: tab.label,
              href: settingsPath(tab.id),
              branch: true,
              children: featureBindingSections(getBundledProviders()).map(
                (group) => ({
                  id: group.id,
                  label: group.label,
                  href: group.href,
                  children: [],
                  branch: false,
                }),
              ),
            }}
            level={2}
            current={current}
          />
        ) : (
          <PageTreeLeafRow
            key={tab.id}
            node={{
              id: tab.id,
              label: tab.label,
              href: settingsPath(tab.id),
              children: [],
              branch: false,
            }}
            level={2}
            current={current}
          />
        ),
      )}
    </div>
  );
}
