import { useLocation, useSearchParams } from "react-router";
import { useEnabledIdentityViews } from "../sections/identity/identity-views.js";
import { identityPageTree } from "../sections/identity/page-tree.js";
import { useIdentityRailSnapshot } from "../sections/identity/use-local-directory.js";
import { PageTreeBranch } from "./PageTreeBranch.js";
import { SectionRow, type SectionTreeProps } from "./RailRows.js";

export function IdentityTree({
  section,
  open,
  active,
  onToggle,
}: SectionTreeProps) {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const views = useEnabledIdentityViews();
  const view =
    views.find((id) => id === params.get("view")) ?? views[0] ?? "people";
  const current = `/identity?view=${view}${hash}`;
  const tabs = identityPageTree(useIdentityRailSnapshot(), views);
  return (
    <>
      <SectionRow
        section={section}
        open={open}
        active={active}
        branch={open}
        onToggle={onToggle}
      />
      {open ? (
        <div className="railtree__kids" id="identity-tree">
          {tabs.map((node) => (
            <PageTreeBranch
              key={node.id}
              node={node}
              level={2}
              current={current}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
