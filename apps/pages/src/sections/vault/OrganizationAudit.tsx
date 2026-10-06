import { auditInventory } from "@opensesame/app-core/lib/password-agent/discover.js";
import { passwordWorkflowAudit } from "@opensesame/app-core/lib/vault/password-workflows.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { FailureNotice } from "../../components/FailureNotice.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
type Audit = Awaited<ReturnType<typeof passwordWorkflowAudit>>;
type AuditSnapshot = {
  report: Audit;
  tomb: string;
  items: readonly VaultItem[];
};

export const organizationAuditSeams = { review: passwordWorkflowAudit };

export function OrganizationAudit() {
  const vault = useVault();
  const [snapshot, setSnapshot] = useState<AuditSnapshot | null>(null);
  const report =
    snapshot !== null &&
    snapshot.tomb === vault.tomb &&
    snapshot.items === vault.items
      ? snapshot.report
      : null;
  const [error, setError] = useState("");
  const target = useGuideTarget<HTMLElement>("vault.health.organization");
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setError("");
    if (vault.status !== "unlocked" || vault.awaitingSecondStep) return;
    if (vault.items.length === 0) {
      setSnapshot({
        report: auditInventory([]),
        tomb: vault.tomb,
        items: vault.items,
      });
      return;
    }
    void organizationAuditSeams.review().then(
      (result) => {
        if (active && vaultStore.getSnapshot().tomb === vault.tomb)
          setSnapshot({ report: result, tomb: vault.tomb, items: vault.items });
      },
      () => {
        if (active) setError("Organization review unavailable.");
      },
    );
    return () => {
      active = false;
    };
  }, [vault.status, vault.awaitingSecondStep, vault.tomb, vault.items]);
  if (vault.status !== "unlocked" || vault.awaitingSecondStep) return null;
  return (
    <section
      className="detail__group"
      ref={target}
      aria-label="Credential organization"
    >
      <h2 className="detail__grouphead">Credential organization</h2>
      <FailureNotice
        id="vault:organization-audit"
        title="Credential organization"
        message={error}
      />
      {report ? (
        <>
          <p>{report.summary.items} active items reviewed</p>
          <AuditItems
            title="Duplicate titles"
            items={report.duplicateTitles.flatMap((group) => group.items)}
          />
          <AuditItems
            title="Machine credentials without tags"
            items={report.untaggedMachineCredentials}
          />
          <AuditItems title="Old login records" items={report.oldLogins} />
          <AuditItems
            title="Transient URLs to review"
            items={report.urlsToReview}
          />
        </>
      ) : null}
    </section>
  );
}
function AuditItems({
  title,
  items,
}: { title: string; items: readonly { id: string; title: string }[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <Link to={`/vault/${item.id}`}>{item.title || "Untitled"}</Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>None</p>
      )}
    </div>
  );
}
