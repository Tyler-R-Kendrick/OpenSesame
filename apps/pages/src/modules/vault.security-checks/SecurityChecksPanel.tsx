/**
 * Breach and two-step checks (`vault.security-checks`): one key runs both
 * checks over the open vault's logins. The outcome is a sentence on this
 * panel and the same sentence on Password health. Nothing is fetched until
 * the key is pressed. Results stay until the capability turns off or the
 * tab closes.
 */
import { SECURITY_CHECKS_SUMMARY } from "@opensesame/app-core/lib/capabilities/catalog-optional-vault.js";
import type { BreachWatch } from "@opensesame/app-core/lib/vault/health.js";
import {
  breachWatchSnapshot,
  subscribeBreachWatch,
} from "@opensesame/app-core/lib/vault/health.js";
import type { CheckFetch } from "@opensesame/app-core/lib/vault/security-checks.js";
import {
  SECURITY_CHECKS_IDLE,
  noteSecurityWatch,
  runSecurityChecks,
} from "@opensesame/app-core/lib/vault/security-checks.js";
import { type ComponentType, useSyncExternalStore } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh, IconShield } from "../../components/Icons.js";
import { StatusMark, type StatusTone } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { CeremonyRow } from "../../sections/settings/CeremonyRow.js";

export type SecurityCheckFetches = {
  range: CheckFetch;
  twoFactor: CheckFetch;
};

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function toneOf(watch: BreachWatch): StatusTone {
  if (watch.phase === "error") return "err";
  if (watch.phase !== "checked") return "idle";
  if (watch.breached > 0) return "err";
  if (watch.twoStep > 0) return "warn";
  return "ok";
}

function statusLabel(watch: BreachWatch): string {
  if (watch.phase === "off" || watch.phase === "idle")
    return SECURITY_CHECKS_IDLE;
  return watch.label;
}

export function securityChecksPanel(
  fetches: SecurityCheckFetches,
): ComponentType {
  return function SecurityChecksPanel() {
    const vault = useVault();
    const watch = useSyncExternalStore(
      subscribeBreachWatch,
      breachWatchSnapshot,
      breachWatchSnapshot,
    );
    const open = vault.status === "unlocked";
    const busy = watch.phase === "checking";
    const label = statusLabel(watch);
    const showMark =
      watch.phase === "checking" ||
      watch.phase === "error" ||
      watch.phase === "checked";

    const check = () => {
      if (busy || !open) return;
      noteSecurityWatch({ phase: "checking" });
      runSecurityChecks(vault.items, fetches.range, fetches.twoFactor).then(
        (report) => noteSecurityWatch({ phase: "checked", report }),
        (caught) =>
          noteSecurityWatch({
            phase: "error",
            message:
              caught instanceof Error ? caught.message : "The check failed.",
          }),
      );
    };

    return (
      <section className="panel set__security" id="security-checks">
        <div className="panel__head">
          <div>
            <h2>Breach and two-step checks</h2>
          </div>
          {showMark ? <StatusMark tone={toneOf(watch)} label={label} /> : null}
        </div>
        <div className="panel__body">
          <p className="hint set__lead">{SECURITY_CHECKS_SUMMARY}</p>
          <p className="set__status">{label}</p>
          <CeremonyRow
            icon={<IconShield size={16} />}
            label="Logins in this vault"
            sub={
              watch.phase === "checked"
                ? plural(watch.checked, "login checked", "logins checked")
                : watch.phase === "checking"
                  ? "Checking"
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
          {watch.phase === "checked"
            ? watch.lines.map((line) => (
                <div className="vault-row" key={line.id}>
                  <div className="vault-row__body">
                    <span className="vault-row__text">
                      <span className="vault-row__name">
                        {line.name || line.site || "Untitled"}
                      </span>
                      {line.site ? (
                        <span className="vault-row__meta">{line.site}</span>
                      ) : null}
                      {line.sentences.map((sentence) => (
                        <span className="set__finding" key={sentence}>
                          {sentence}
                        </span>
                      ))}
                    </span>
                  </div>
                  {line.breaches > 0 ? (
                    <StatusMark tone="err" label={line.sentences[0] ?? ""} />
                  ) : null}
                  {line.twoFactorAvailable ? (
                    <StatusMark
                      tone="warn"
                      label={line.sentences[line.breaches > 0 ? 1 : 0] ?? ""}
                    />
                  ) : null}
                </div>
              ))
            : null}
        </div>
      </section>
    );
  };
}
