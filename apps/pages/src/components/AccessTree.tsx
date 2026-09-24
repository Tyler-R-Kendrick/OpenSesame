import { useLocation, useSearchParams } from "react-router";

import {
  useHostConfigured,
  useIdentityConfigured,
} from "../lib/use-configured.js";
import { useVault } from "../lib/vault/hooks.js";
import { accessPageTree } from "../sections/access/page-tree.js";
import { useShareLeaves } from "../sections/access/share-leaves.js";
import { PageTreeBranch } from "./PageTreeBranch.js";
import { SectionRow, type SectionTreeProps } from "./RailRows.js";

import { ACCESS_VIEWS } from "@opensesame/app-core/lib/section-view-names.js";
export function AccessTree({
  section,
  open,
  active,
  onToggle,
}: SectionTreeProps) {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const host = useHostConfigured();
  const identity = useIdentityConfigured();
  const view = ACCESS_VIEWS.find((id) => id === params.get("view")) ?? "grants";
  const current = `/access?view=${view}${hash}`;
  const { tomb } = useVault();
  const shares = useShareLeaves(tomb);
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
        <div className="railtree__kids" id="access-tree">
          {accessPageTree({ host, identity, shares }).map((node) => (
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
