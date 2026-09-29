import type { ProtectorViewRow } from "@opensesame/app-core/lib/vault/protection/protection-view.js";
import { protectorCanBeTested } from "@opensesame/app-core/lib/vault/protection/protector-proof.js";
import { protectorUnlocksVault } from "@opensesame/app-core/lib/vault/unlock-preference.js";
import type { ReactNode } from "react";
import { IconRefresh, IconStar, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

function proofMark(row: ProtectorViewRow): ReactNode {
  if (row.proofStatus === "verified") {
    return <StatusMark tone="ok" label="Verified" />;
  }
  if (row.proofStatus === "stale") {
    return <StatusMark tone="warn" label="Stale" />;
  }
  return <StatusMark tone="idle" label="Untested" />;
}

export function ProtectorRow({
  row,
  preferred,
  onTest,
  onPreferred,
  onRemove,
}: {
  row: ProtectorViewRow;
  preferred: boolean;
  onTest: (id: string) => void;
  onPreferred: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  // Only the header's own wraps open the vault, so only they can be preferred
  // — and they are removed under Unlock methods, where the wrap goes with the
  // row. Every other protector is proved with Test and removed here.
  const unlocks = protectorUnlocksVault(row);
  return (
    <div className="sw sw--method" data-protector-id={row.protectorId}>
      <div>
        <div className="sw__name">
          {row.mechanismLabel}
          {proofMark(row)}
          {preferred ? <StatusMark tone="ok" label="Preferred unlock" /> : null}
        </div>
        <p className="sw__sub">{row.identityLabel}</p>
      </div>
      <div className="actions">
        {protectorCanBeTested(row.kind) ? (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Test ${row.mechanismLabel}`}
            title={`Test ${row.mechanismLabel}`}
            onClick={() => onTest(row.protectorId)}
          >
            <IconRefresh size={16} />
          </button>
        ) : null}
        {unlocks ? (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Preferred unlock ${row.mechanismLabel}`}
            title={`Preferred unlock ${row.mechanismLabel}`}
            onClick={() => onPreferred(row.protectorId)}
          >
            <IconStar size={16} />
          </button>
        ) : null}
        {unlocks ? null : (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Remove ${row.mechanismLabel}`}
            title={`Remove ${row.mechanismLabel}`}
            onClick={() => onRemove(row.protectorId)}
          >
            <IconTrash size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
