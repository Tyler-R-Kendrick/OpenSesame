/**
 * The Identity section's rail entries — one subtree per record list,
 * with its records underneath. The views are whatever the
 * identity capabilities contributed (`sections/identity/identity-views.ts`);
 * the shell draws the section row from the `section` contribution.
 */

import type { TreeProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { useLocation, useSearchParams } from "react-router";
import { PageTreeBranch } from "../../components/PageTreeBranch.js";
import { useEnabledIdentityViews } from "../../sections/identity/identity-views.js";
import { identityPageTree } from "../../sections/identity/page-tree.js";
import { useIdentityRailSnapshot } from "../../sections/identity/use-local-directory.js";

export function IdentityRailTree(_props: TreeProps) {
  const [params] = useSearchParams();
  const { hash, pathname } = useLocation();
  const views = useEnabledIdentityViews();
  const view =
    views.find((id) => id === params.get("view")) ?? views[0] ?? "people";
  const current =
    pathname === "/identity" ? `/identity?view=${view}${hash}` : "";
  const branches = identityPageTree(useIdentityRailSnapshot(), views);
  return (
    <div className="railtree__kids" id="identity-tree">
      {branches.map((node) => (
        <PageTreeBranch key={node.id} node={node} level={2} current={current} />
      ))}
    </div>
  );
}
