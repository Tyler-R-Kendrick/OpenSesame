/**
 * Breach and two-step checks (`vault.security-checks`): one key runs both
 * checks over the open vault's logins. The outcome is a sentence on this
 * panel and the same sentence on Password health. Nothing is fetched until
 * the key is pressed. Results stay until the capability turns off or the
 * tab closes.
 */
import {
  breachWatchSnapshot,
  subscribeBreachWatch,
} from "@opensesame/app-core/lib/vault/health.js";
import type { CheckFetch } from "@opensesame/app-core/lib/vault/security-checks.js";
import {
  SECURITY_CHECKS_IDLE,
  noteSecurityWatch,
  reconcileSecurityWatchWithVault,
  runSecurityChecks,
} from "@opensesame/app-core/lib/vault/security-checks.js";
import { type ComponentType, useSyncExternalStore } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh, IconShield } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";
import { CeremonyRow } from "../../sections/settings/CeremonyRow.js";

export type SecurityCheckFetches = {
  range: CheckFetch;
  twoFactor: CheckFetch;
};

export function securityChecksPanel(
  fetches: SecurityCheckFetches,
): ComponentType {
  return function SecurityChecksPanel() {
    const vault = useVault();
    reconcileSecurityWatchWithVault(vault.tomb, vault.items);
    const watch = useSyncExternalStore(
      subscribeBreachWatch,
      breachWatchSnapshot,
      breachWatchSnapshot,
    );
    const open = vault.status === "unlocked";
    const busy = watch.phase === "checking";
    const label =
      watch.phase === "off" || watch.phase === "idle"
        ? SECURITY_CHECKS_IDLE
        : watch.label;

    const check = () => {
      if (busy || !open) return;
      noteSecurityWatch({ phase: "checking" });
      runSecurityChecks(
        vault.items,
        fetches.range,
        fetches.twoFactor,
        undefined,
        vault.tomb,
      ).then(
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
        </div>
        <div className="panel__body">
          <p className="set__status">{label}</p>
          <CeremonyRow
            icon={<IconShield size={16} />}
            label="Logins in this vault"
            sub={
              watch.phase === "checked"
                ? `${watch.checked.toLocaleString()} ${
                    watch.checked === 1 ? "login checked" : "logins checked"
                  }`
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
                </div>
              ))
            : null}
        </div>
      </section>
    );
  };
}
