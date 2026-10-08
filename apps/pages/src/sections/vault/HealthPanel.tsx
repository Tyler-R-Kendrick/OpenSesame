import { settingsPath } from "@opensesame/app-core/lib/crumbs.js";
import {
  type BreachWatch,
  ISSUE_EXPLANATION,
  ISSUE_LABEL,
  breachWatchSnapshot,
  buildHealthReport,
  subscribeBreachWatch,
} from "@opensesame/app-core/lib/vault/health.js";
import { useMemo, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { EmptyTip } from "../../components/EmptyTip.js";
import { IconChevronLeft, IconEdit } from "../../components/Icons.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

import { OrganizationAudit } from "./OrganizationAudit.js";

const ISSUE_TONE = {
  weak: "chip--err",
  reused: "chip--err",
  old: "chip--warn",
  "no-2fa": "chip--warn",
};

function BreachWatchBlock({
  watch,
}: {
  watch: Exclude<BreachWatch, { phase: "off" }>;
}) {
  return (
    <section className="detail__group" aria-label="Breach and two-step checks">
      <h2 className="detail__grouphead">Breach and two-step checks</h2>
      <p className="health__line">{watch.label}</p>
      {watch.phase === "checked"
        ? watch.lines.map((line) => (
            <article className="health__finding" key={line.id}>
              <div className="health__findinghead">
                <Link to={`/vault/${line.id}`}>
                  <strong>{line.name || line.site || "Untitled"}</strong>
                </Link>
                {line.site ? <span className="hint">{line.site}</span> : null}
              </div>
              {line.sentences.map((sentence) => (
                <p className="health__why" key={sentence}>
                  {sentence}
                </p>
              ))}
            </article>
          ))
        : null}
      <p>
        <Link to={settingsPath("capabilities", "feature-security-checks")}>
          Open breach and two-step checks
        </Link>
      </p>
    </section>
  );
}

export function HealthPanel() {
  const { items } = useVault();
  const report = useMemo(() => buildHealthReport(items), [items]);
  const watch = useSyncExternalStore(
    subscribeBreachWatch,
    breachWatchSnapshot,
    breachWatchSnapshot,
  );
  const summaryRef = useGuideTarget<HTMLElement>("vault.health.summary");
  const findingsRef = useGuideTarget<HTMLElement>("vault.health.findings");

  return (
    <div className="detail">
      <div className="detail__head">
        <Link
          className="icon-btn detail__backbtn"
          aria-label="Back to all items"
          title="Back to all items"
          to="/vault"
        >
          <IconChevronLeft size={17} />
        </Link>
        <div className="detail__heading">
          <h1>Password health</h1>
        </div>
      </div>

      {report.scored === 0 ? (
        // The empty report is the verdict and the whole list at once, so it
        // answers for both targets a health tutorial points at.
        <div className="empty" ref={findingsRef}>
          <h2 ref={summaryRef}>No passwords to review</h2>
          <EmptyTip tip="vaultEmpty" />
          <Link className="btn btn--primary btn--sm" to="/vault/new/account">
            New account
          </Link>
        </div>
      ) : (
        <div className="health">
          {/* The verdict is one status line, not a metric wall. */}
          <p className="health__line" ref={summaryRef}>
            {report.scored} reviewed · {report.clean} clean
            {report.counts.weak > 0 ? (
              <span className="health__bad"> · {report.counts.weak} weak</span>
            ) : null}
            {report.counts.reused > 0 ? (
              <span className="health__bad">
                {" "}
                · {report.counts.reused} reused
              </span>
            ) : null}
            {report.counts.old > 0 ? (
              <span> · {report.counts.old} old</span>
            ) : null}
            {report.unchecked > 0 ? (
              <span> · {report.unchecked} unchecked</span>
            ) : null}
          </p>

          {report.findings.length === 0 ? (
            <div className="note note--ok" ref={findingsRef}>
              <span>
                Every password here is strong, unique, and under a year old.
                Nothing to do.
              </span>
            </div>
          ) : (
            <section className="detail__group" ref={findingsRef}>
              <h2 className="detail__grouphead">
                {report.findings.length}{" "}
                {report.findings.length === 1 ? "item needs" : "items need"}{" "}
                attention
              </h2>
              {report.findings.map((finding) => (
                <article className="health__finding" key={finding.item.id}>
                  <div className="health__findinghead">
                    <Link to={`/vault/${finding.item.id}`}>
                      <strong>{finding.item.name || "Untitled"}</strong>
                    </Link>
                    <span className="hint">≈{finding.bits} bits</span>
                  </div>
                  <ul className="health__issues">
                    {finding.issues.map((issue) => (
                      <li key={issue}>
                        <StatusMark
                          tone={statusTone(ISSUE_TONE[issue])}
                          label={ISSUE_LABEL[issue]}
                        />
                        <span className="health__why">
                          {issue === "reused" && finding.sharedWith.length > 0
                            ? `Also used for ${finding.sharedWith.join(", ")}. One breach there unlocks this too.`
                            : ISSUE_EXPLANATION[issue]}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="actions">
                    <Link
                      className="icon-btn"
                      aria-label={`Fix ${finding.item.name || "this item"}`}
                      title="Fix — edit this item"
                      to={`/vault/${finding.item.id}/edit`}
                    >
                      <IconEdit size={16} />
                    </Link>
                  </div>
                </article>
              ))}
            </section>
          )}
        </div>
      )}
      {watch.phase === "off" ? null : <BreachWatchBlock watch={watch} />}
      <OrganizationAudit />
    </div>
  );
}
