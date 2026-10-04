import type { ProtectorViewRow } from "@opensesame/app-core/lib/vault/protection/protection-view.js";
import { protectorCanBeTested } from "@opensesame/app-core/lib/vault/protection/protector-proof.js";
import {
  protectorIsHeaderWrap,
  protectorUnlocksVault,
} from "@opensesame/app-core/lib/vault/unlock-preference.js";
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
  // What opens the vault at the unlock screen can be preferred: the header's
  // own wraps, and a verified recovery key, age key or passkey capsule
  // (ADR 0152). A header wrap is removed under Unlock methods, where the wrap
  // goes with the row; every other protector is proved with Test and removed
  // here.
  const unlocks = protectorUnlocksVault(row);
  const isHeaderWrap = protectorIsHeaderWrap(row);
  return (
    <div className="sw sw--method" data-protector-id={row.protectorId}>
      <div>
        <div className="sw__name">
          {row.mechanismLabel}
          {proofMark(row)}
          {row.dependsOnVault && row.proofStatus === "verified" ? (
            <StatusMark
              tone="idle"
              label="Its credential is sealed in this vault, so it is not a way back in"
            />
          ) : null}
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
        {/* The preferred one is marked; its key would do nothing (ADR 0158). */}
        {unlocks && !preferred ? (
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
        {isHeaderWrap ? null : (
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
