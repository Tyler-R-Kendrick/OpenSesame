import { useLocation, useSearchParams } from "react-router";
import { ACCESS_VIEWS } from "../lib/section-views.js";
import {
  useHostConfigured,
  useIdentityConfigured,
} from "../lib/use-configured.js";
import { useVaultStore } from "../lib/vault/hooks.js";
import { useLocalShares } from "../sections/access/LocalSharePanel.js";
import { accessPageTree } from "../sections/access/page-tree.js";
import { PageTreeBranch } from "./PageTreeBranch.js";
import { SECTIONS, SectionRow } from "./RailRows.js";

export function AccessTree({
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
  const host = useHostConfigured();
  const identity = useIdentityConfigured();
  const view = ACCESS_VIEWS.find((id) => id === params.get("view")) ?? "grants";
  const current = `/access?view=${view}${hash}`;
  const tomb = useVaultStore().activeTomb?.() ?? "";
  const shares = useLocalShares(tomb).shares.map((share) => ({
    id: share.id,
    label: `${share.resourceKind}: ${share.resourceLabel}`,
  }));
  return (
    <>
      <SectionRow
        section={SECTIONS[2]}
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
