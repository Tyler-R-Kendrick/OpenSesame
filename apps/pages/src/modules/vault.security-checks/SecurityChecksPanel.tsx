/**
 * Settings › Vaults › Breach and two-step checks (`vault.security-checks`):
 * one key runs both checks over the open vault's logins, and each login it
 * found something on is a row, its findings as glyphs. Nothing is checked
 * until the key is pressed, and nothing found is kept past the tab.
 */
import type { CheckFetch } from "@opensesame/app-core/lib/vault/security-checks.js";
import {
  type SecurityReport,
  runSecurityChecks,
} from "@opensesame/app-core/lib/vault/security-checks.js";
import { hostOf } from "@opensesame/vault-core";
import { type ComponentType, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh, IconShield } from "../../components/Icons.js";
import { StatusMark, type StatusTone } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { CeremonyRow } from "../../sections/settings/CeremonyRow.js";

export type SecurityCheckFetches = {
  range: CheckFetch;
  twoFactor: CheckFetch;
};

type Standing = { tone: StatusTone; label: string };

function standingOf(
  report: SecurityReport | null,
  error: string | null,
  busy: boolean,
): Standing | null {
  if (busy) return { tone: "idle", label: "Checking" };
  if (error) return { tone: "err", label: error };
  if (!report) return null;
  const breached = report.findings.filter((f) => f.breaches > 0).length;
  const time = new Date(report.checkedAt).toLocaleTimeString();
  if (breached > 0)
    return {
      tone: "err",
      label: `${breached} of ${report.checked} passwords found in breaches, checked at ${time}`,
    };
  if (report.findings.length > 0)
    return {
      tone: "warn",
      label: `${report.findings.length} logins could add an authenticator code, checked at ${time}`,
    };
  return {
    tone: "ok",
    label: `${report.checked} logins checked at ${time}: nothing found`,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function securityChecksPanel(
  fetches: SecurityCheckFetches,
): ComponentType {
  return function SecurityChecksPanel() {
    const vault = useVault();
    const [report, setReport] = useState<SecurityReport | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const open = vault.status === "unlocked";

    const check = () => {
      if (busy || !open) return;
      setBusy(true);
      setError(null);
      runSecurityChecks(vault.items, fetches.range, fetches.twoFactor)
        .then(setReport, (caught) =>
          setError(
            caught instanceof Error ? caught.message : "The check failed.",
          ),
        )
        .finally(() => setBusy(false));
    };

    const standing = standingOf(report, error, busy);
    return (
      <section className="panel set__security" id="security-checks">
        <div className="panel__head">
          <div>
            <h2>Breach and two-step checks</h2>
          </div>
          {standing ? (
            <StatusMark tone={standing.tone} label={standing.label} />
          ) : null}
        </div>
        <div className="panel__body">
          <CeremonyRow
            icon={<IconShield size={16} />}
            label="Logins in this vault"
            sub={
              report
                ? plural(report.checked, "login checked", "logins checked")
                : "Not checked"
            }
            action={
              <IconKey
                small
                label="Check logins against breaches and two-step sites"
                disabled={busy || !open}
                onClick={check}
              >
                <IconRefresh size={16} />
              </IconKey>
            }
          />
          {report?.findings.map((finding) => (
            <div className="vault-row" key={finding.item.id}>
              <div className="vault-row__body">
                <span className="vault-row__text">
                  <span className="vault-row__name">
                    {finding.item.name || hostOf(finding.item.uris[0]?.uri)}
                  </span>
                  <span className="vault-row__meta">
                    {hostOf(finding.item.uris[0]?.uri)}
                  </span>
                </span>
              </div>
              {finding.breaches > 0 ? (
                <StatusMark
                  tone="err"
                  label={`Found in breaches ${plural(finding.breaches, "time", "times")}: change this password`}
                />
              ) : null}
              {finding.twoFactorAvailable ? (
                <StatusMark
                  tone="warn"
                  label="This site takes an authenticator code; none is stored"
                />
              ) : null}
            </div>
          ))}
        </div>
      </section>
    );
  };
}
