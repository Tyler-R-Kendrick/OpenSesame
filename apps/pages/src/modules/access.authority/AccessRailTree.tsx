/**
 * The Access section's rail entries — one subtree per tab, listing the
 * panels that tab draws, with the local share grants under Grants. The shell draws the section row itself
 * from the `section` contribution; this is only what opens beneath it, and
 * it exists only while `access.authority` is active.
 */

import type { TreeProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { useLocation, useSearchParams } from "react-router";
import { PageTreeBranch } from "../../components/PageTreeBranch.js";

import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useVault } from "../../lib/vault/hooks.js";
import { accessPageTree } from "../../sections/access/page-tree.js";
import { useShareLeaves } from "../../sections/access/share-leaves.js";
import { useHasPortableGrants } from "../../sections/access/use-access-book.js";
import { useReceiptsSession } from "../../sections/access/use-receipts-session.js";

import { ACCESS_VIEWS } from "@opensesame/app-core/lib/section-view-names.js";
export function AccessRailTree(_props: TreeProps) {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const identity = useIdentityConfigured();
  // The same rules AccessSection draws Portable grants and Receipts by.
  const book = useHasPortableGrants();
  const receipts = useReceiptsSession() !== null;
  const view = ACCESS_VIEWS.find((id) => id === params.get("view")) ?? "grants";
  const current = `/access?view=${view}${hash}`;
  const { tomb } = useVault();
  const shares = useShareLeaves(tomb);
  return (
    <div className="railtree__kids" id="access-tree">
      {accessPageTree({ identity, book, receipts, shares }).map((node) => (
        <PageTreeBranch key={node.id} node={node} level={2} current={current} />
      ))}
    </div>
  );
}
