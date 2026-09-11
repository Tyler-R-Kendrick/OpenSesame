import { useLocation, useSearchParams } from "react-router";
import { IDENTITY_VIEWS } from "../lib/section-views.js";
import { identityPageTree } from "../sections/identity/page-tree.js";
import { useIdentityRailSnapshot } from "../sections/identity/use-local-directory.js";
import { PageTreeBranch } from "./PageTreeBranch.js";
import { SECTIONS, SectionRow } from "./RailRows.js";

export function IdentityTree({
  open,
  active,
  onToggle,
}: {
  open: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const view =
    IDENTITY_VIEWS.find((id) => id === params.get("view")) ?? "people";
  const current = `/identity?view=${view}${hash}`;
  const tabs = identityPageTree(useIdentityRailSnapshot());
  return (
    <>
      <SectionRow
        section={SECTIONS[3]}
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
