import { passwordWorkflowAudit } from "@opensesame/app-core/lib/vault/password-workflows.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { FailureNotice } from "../../components/FailureNotice.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";

type Audit = Awaited<ReturnType<typeof passwordWorkflowAudit>>;
type AuditSnapshot = {
  report: Audit;
  tomb: string;
  items: readonly VaultItem[];
};

export const organizationAuditSeams = { review: passwordWorkflowAudit };

type Reason = { label: string; why: string };
type Finding = { id: string; title: string; reasons: Reason[] };

const DUPLICATE: Reason = {
  label: "Duplicate title",
  why: "Another item has this title.",
};
const UNFILED: Reason = {
  label: "Unfiled",
  why: "A key or token outside any folder.",
};
const OLD: Reason = {
  label: "Old login",
  why: "Last changed over a year ago.",
};
const ADDRESS: Reason = {
  label: "Address to review",
  why: "A saved address may carry a credential.",
};

/** One row per item, with every reason the audit found it for. */
function findingsOf(report: Audit): Finding[] {
  const found = new Map<string, Finding>();
  const add = (item: { id: string; title: string }, reason: Reason) => {
    const entry = found.get(item.id) ?? {
      id: item.id,
      title: item.title,
      reasons: [],
    };
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    found.set(item.id, entry);
  };
  for (const group of report.duplicateTitles)
    for (const item of group.items) add(item, DUPLICATE);
  for (const item of report.untaggedMachineCredentials) add(item, UNFILED);
  for (const item of report.oldLogins) add(item, OLD);
  for (const item of report.urlsToReview) add(item, ADDRESS);
  return [...found.values()];
}

/**
 * The same metadata review a person or an agent can ask for by name, drawn as
 * Health already draws a finding: the item, a link to it, and each reason as a
 * mark. It reads titles and origins, never a value.
 */
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
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setError("");
    if (vault.status !== "unlocked" || vault.awaitingSecondStep) return;
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
  const findings = useMemo(() => (report ? findingsOf(report) : []), [report]);
  if (vault.status !== "unlocked" || vault.awaitingSecondStep) return null;
  return (
    <>
      <FailureNotice
        id="vault:organization-audit"
        title="Organization review"
        message={error}
      />
      {findings.length > 0 ? (
        <section className="detail__group" aria-label="Organization">
          <h2 className="detail__grouphead">
            {findings.length} {findings.length === 1 ? "item" : "items"} to file
            or rename
          </h2>
          {findings.map((finding) => (
            <article className="health__finding" key={finding.id}>
              <div className="health__findinghead">
                <Link to={`/vault/${finding.id}`}>
                  <strong>{finding.title || "Untitled"}</strong>
                </Link>
              </div>
              <ul className="health__issues">
                {finding.reasons.map((reason) => (
                  <li key={reason.label}>
                    <StatusMark tone="warn" label={reason.label} />
                    <span className="health__why">{reason.why}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      ) : null}
    </>
  );
}
