import { useMemo } from "react";
import { Link } from "react-router";
import { IconChevronLeft, IconShield } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";
import {
  buildHealthReport,
  ISSUE_EXPLANATION,
  ISSUE_LABEL,
  type HealthIssue,
} from "../../lib/vault/health.js";

const ISSUE_TONE: Record<HealthIssue, string> = {
  weak: "chip--err",
  reused: "chip--err",
  old: "chip--warn",
  "no-2fa": "chip--warn",
};

export function HealthPanel() {
  const { items } = useVault();
  const report = useMemo(() => buildHealthReport(items), [items]);

  return (
    <div className="detail">
      <Link className="btn btn--ghost btn--sm detail__back" to="/vault">
        <IconChevronLeft size={16} />
        All items
      </Link>

      <div className="detail__head">
        <span className="detail__mark" aria-hidden="true">
          <IconShield size={22} />
        </span>
        <div className="detail__heading">
          <h1>Password health</h1>
          <p className="hint">
            Computed here, over the decrypted collection. No password, and no hash of
            one, leaves this device — this report never contacts a breach service.
          </p>
        </div>
      </div>

      {report.scored === 0 ? (
        <div className="empty">
          <span className="empty__mark" aria-hidden="true">
            <IconShield size={22} />
          </span>
          <h3>No passwords to review</h3>
          <p>
            Add a login with a password and it will be scored for strength, reuse, and
            age.
          </p>
          <Link className="btn btn--primary btn--sm" to="/vault/new/login">
            New login
          </Link>
        </div>
      ) : (
        <div className="health">
          <div className="health__summary">
            <div className="health__stat">
              <p className="health__statnum">{report.scored}</p>
              <p className="health__statlabel">Passwords reviewed</p>
            </div>
            <div className="health__stat">
              <p
                className="health__statnum"
                style={{ color: report.clean === report.scored ? "var(--ok)" : undefined }}
              >
                {report.clean}
              </p>
              <p className="health__statlabel">Clean</p>
            </div>
            <div className="health__stat">
              <p
                className="health__statnum"
                style={{ color: report.counts.weak > 0 ? "var(--err)" : undefined }}
              >
                {report.counts.weak}
              </p>
              <p className="health__statlabel">Weak</p>
            </div>
            <div className="health__stat">
              <p
                className="health__statnum"
                style={{ color: report.counts.reused > 0 ? "var(--err)" : undefined }}
              >
                {report.counts.reused}
              </p>
              <p className="health__statlabel">Reused</p>
            </div>
          </div>

          {report.findings.length === 0 ? (
            <div className="note note--ok">
              <span>
                Every password here is strong, unique, and under a year old. Nothing to
                do.
              </span>
            </div>
          ) : (
            <section className="detail__group">
              <h2 className="detail__grouphead">
                {report.findings.length}{" "}
                {report.findings.length === 1 ? "item needs" : "items need"} attention
              </h2>
              {report.findings.map((finding) => (
                <article className="health__finding" key={finding.item.id}>
                  <div className="health__findinghead">
                    <Link to={`/vault/${finding.item.id}`}>
                      <strong>{finding.item.name || "Untitled"}</strong>
                    </Link>
                    <span className="hint">≈{finding.bits} bits</span>
                  </div>
                  <div className="health__issues">
                    {finding.issues.map((issue) => (
                      <span key={issue} className={`chip ${ISSUE_TONE[issue]}`}>
                        {ISSUE_LABEL[issue]}
                      </span>
                    ))}
                  </div>
                  <p className="health__why">
                    {finding.issues.map((issue) => ISSUE_EXPLANATION[issue]).join(" ")}
                    {finding.sharedWith.length > 0
                      ? ` Shared with ${finding.sharedWith.join(", ")}.`
                      : ""}
                  </p>
                  <div className="actions">
                    <Link
                      className="btn btn--sm"
                      to={`/vault/${finding.item.id}/edit`}
                    >
                      Fix this
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
