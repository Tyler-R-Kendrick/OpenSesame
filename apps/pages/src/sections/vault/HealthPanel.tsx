import { useMemo } from "react";
import { Link } from "react-router";
import { IconChevronLeft, IconEdit } from "../../components/Icons.js";
import {
  type HealthIssue,
  ISSUE_EXPLANATION,
  ISSUE_LABEL,
  buildHealthReport,
} from "../../lib/vault/health.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

const ISSUE_TONE = {
  weak: "chip--err",
  reused: "chip--err",
  old: "chip--warn",
  "no-2fa": "chip--warn",
};

export function HealthPanel() {
  const { items } = useVault();
  const report = useMemo(() => buildHealthReport(items), [items]);
  const summaryRef = useGuideTarget<HTMLParagraphElement>(
    "vault.health.summary",
  );
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
        <div className="empty">
          <h2>No passwords to review</h2>
          <Link className="btn btn--primary btn--sm" to="/vault/new/login">
            New login
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
          </p>

          {report.findings.length === 0 ? (
            <div className="note note--ok">
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
                        <span className={`chip ${ISSUE_TONE[issue]}`}>
                          {ISSUE_LABEL[issue]}
                        </span>
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
    </div>
  );
}
