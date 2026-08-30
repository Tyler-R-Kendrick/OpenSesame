import { useMemo } from "react";
import { Link } from "react-router";
import { IconChevronLeft, IconShield } from "../../components/Icons.js";
import {
  type HealthIssue,
  ISSUE_EXPLANATION,
  ISSUE_LABEL,
  buildHealthReport,
} from "../../lib/vault/health.js";
import { useVault } from "../../lib/vault/hooks.js";

const ISSUE_TONE = {
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
            Computed here, over the decrypted collection. No password, and no
            hash of one, leaves this device — this report never contacts a
            breach service.
          </p>
        </div>
      </div>

      {report.scored === 0 ? (
        <div className="empty">
          <span className="empty__mark" aria-hidden="true">
            <IconShield size={22} />
          </span>
          <h2>No passwords to review</h2>
          <p>
            Add a login with a password and it will be scored for strength,
            reuse, and age.
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
                style={{
                  color:
                    report.clean === report.scored ? "var(--ok)" : undefined,
                }}
              >
                {report.clean}
              </p>
              <p className="health__statlabel">Clean</p>
            </div>
            <div className="health__stat">
              <p
                className="health__statnum"
                style={{
                  color: report.counts.weak > 0 ? "var(--err)" : undefined,
                }}
              >
                {report.counts.weak}
              </p>
              <p className="health__statlabel">Weak</p>
            </div>
            <div className="health__stat">
              <p
                className="health__statnum"
                style={{
                  color: report.counts.reused > 0 ? "var(--err)" : undefined,
                }}
              >
                {report.counts.reused}
              </p>
              <p className="health__statlabel">Reused</p>
            </div>
          </div>

          {report.findings.length === 0 ? (
            <div className="note note--ok">
              <span>
                Every password here is strong, unique, and under a year old.
                Nothing to do.
              </span>
            </div>
          ) : (
            <section className="detail__group">
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
