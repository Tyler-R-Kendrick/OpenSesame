/**
 * The Access section's rail entries — one subtree per tab, listing the
 * panels that tab draws, with the local share grants under Grants. The shell draws the section row itself
 * from the `section` contribution; this is only what opens beneath it, and
 * it exists only while `access.authority` is active.
 */

import { accessViewFromLocation } from "@opensesame/app-core/lib/access-routes.js";
import type { TreeProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { useLocation } from "react-router";
import { PageTreeBranch } from "../../components/PageTreeBranch.js";

import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useVault } from "../../lib/vault/hooks.js";
import { accessPageTree } from "../../sections/access/page-tree.js";
import { accessRailHash } from "../../sections/access/rail-route.js";
import { useShareLeaves } from "../../sections/access/share-leaves.js";
import { useHasPortableGrants } from "../../sections/access/use-access-book.js";
import { useReceiptsSession } from "../../sections/access/use-receipts-session.js";

export function AccessRailTree(_props: TreeProps) {
  const location = useLocation();
  const { hash } = location;
  const identity = useIdentityConfigured();
  // The same rules AccessSection draws Portable grants and Receipts by.
  const book = useHasPortableGrants();
  const receipts = useReceiptsSession() !== null;
  const view = accessViewFromLocation(location.pathname, location.search);
  const current = `/access?view=${view}${accessRailHash(hash)}`;
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
