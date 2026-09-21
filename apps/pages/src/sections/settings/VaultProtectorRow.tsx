import type { ReactNode } from "react";
import { IconRefresh, IconStar, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { ProtectorViewRow } from "../../lib/vault/protection/protection-view.js";

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
  disabledReason,
  actionsWired,
  onTest,
  onPreferred,
  onRemove,
}: {
  row: ProtectorViewRow;
  preferred: boolean;
  disabledReason: string | undefined;
  actionsWired: boolean;
  onTest: (id: string) => void;
  onPreferred: (id: string) => void;
  onRemove: (id: string) => void;
}) {
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
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Test ${row.mechanismLabel}`}
          title={disabledReason ?? `Test ${row.mechanismLabel}`}
          disabled={!actionsWired}
          onClick={() => onTest(row.protectorId)}
        >
          <IconRefresh size={16} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Preferred unlock ${row.mechanismLabel}`}
          title={disabledReason ?? `Preferred unlock ${row.mechanismLabel}`}
          disabled={!actionsWired}
          onClick={() => onPreferred(row.protectorId)}
        >
          <IconStar size={16} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Remove ${row.mechanismLabel}`}
          title={disabledReason ?? `Remove ${row.mechanismLabel}`}
          disabled={!actionsWired}
          onClick={() => onRemove(row.protectorId)}
        >
          <IconTrash size={16} />
        </button>
      </div>
    </div>
  );
}
