import type { StorePlainEntry } from "@opensesame/app-core/lib/vault/store-sync.js";
import {
  type ManifestPlan,
  manifestCommitLabel,
  manifestFacts,
} from "@opensesame/app-core/sections/vault/import/store-manifest.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { ErrorMark } from "./ImportCards.js";

/**
 * A store path manifest (ADR 0037 §6), read back: what merging it by path
 * would write, and the one commit that writes it. Nothing here names an
 * item — the facts are counts, and the file's own name heads the card.
 */
export function ManifestCard({
  fileName,
  entries,
  plan,
  busy,
  error,
  onConfirm,
}: {
  fileName: string;
  entries: readonly StorePlainEntry[];
  plan: ManifestPlan;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const writes = plan.adds.length + plan.updates.length;
  return (
    <CeremonyShell
      ok={error === null}
      name={fileName}
      facts={manifestFacts(entries, plan)}
      primary={{
        label: manifestCommitLabel(plan),
        busy,
        disabled: writes === 0,
        onClick: onConfirm,
      }}
    >
      {error ? (
        <p className="imp__marks">
          <ErrorMark error={error} />
        </p>
      ) : null}
    </CeremonyShell>
  );
}
