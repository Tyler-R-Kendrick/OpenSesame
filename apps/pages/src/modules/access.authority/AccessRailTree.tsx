/**
 * The Access section's rail entries — one subtree per tab, with the local
 * share grants listed under Grants. The shell draws the section row itself
 * from the `section` contribution; this is only what opens beneath it, and
 * it exists only while `access.authority` is active.
 */

import type { TreeProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { useLocation, useSearchParams } from "react-router";
import { PageTreeBranch } from "../../components/PageTreeBranch.js";

import {
  useHostConfigured,
  useIdentityConfigured,
} from "../../lib/use-configured.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useLocalShares } from "../../sections/access/LocalSharePanel.js";
import { accessPageTree } from "../../sections/access/page-tree.js";

import { ACCESS_VIEWS } from "@opensesame/app-core/lib/section-view-names.js";
export function AccessRailTree(_props: TreeProps) {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const host = useHostConfigured();
  const identity = useIdentityConfigured();
  const view = ACCESS_VIEWS.find((id) => id === params.get("view")) ?? "grants";
  const current = `/access?view=${view}${hash}`;
  const { tomb } = useVault();
  const shares = useLocalShares(tomb).shares.map((share) => ({
    id: share.id,
    label: `${share.resourceKind}: ${share.resourceLabel}`,
  }));
  return (
    <div className="railtree__kids" id="access-tree">
      {accessPageTree({ host, identity, shares }).map((node) => (
        <PageTreeBranch key={node.id} node={node} level={2} current={current} />
      ))}
    </div>
  );
}
