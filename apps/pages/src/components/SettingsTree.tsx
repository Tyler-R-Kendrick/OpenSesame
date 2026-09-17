import { SETTINGS_CATEGORIES, settingsPath } from "../lib/crumbs.js";
import { settingsPageTree } from "../sections/settings/page-tree.js";
import { PageTreeLeafRow } from "./PageTreeBranch.js";

export function SettingsTree({ current }: { current: string }) {
  const projected = settingsPageTree();
  return (
    <div className="railtree__kids">
      {SETTINGS_CATEGORIES.map((category) => (
        <PageTreeLeafRow
          key={category}
          node={{
            id: category,
            label: category,
            href: settingsPath(category),
            children: [],
            branch: false,
          }}
          level={2}
          current={current}
        />
      ))}
      {projected.flatMap((node) =>
        node.children.map((child) => (
          <PageTreeLeafRow
            key={child.id}
            node={child}
            level={2}
            current={current}
          />
        )),
      )}
    </div>
  );
}
