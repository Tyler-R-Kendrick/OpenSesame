/**
 * Breach and two-step checks (`vault.security-checks`): one key runs both
 * checks over the open vault's logins. The outcome is a sentence on this
 * panel and the same sentence on Password health. Nothing is fetched until
 * the key is pressed. Results stay until the capability turns off or the
 * tab closes.
 */
import type { BreachWatch } from "@opensesame/app-core/lib/vault/health.js";
import {
  breachWatchSnapshot,
  subscribeBreachWatch,
} from "@opensesame/app-core/lib/vault/health.js";
import type { CheckFetch } from "@opensesame/app-core/lib/vault/security-checks.js";
import {
  SECURITY_CHECKS_IDLE,
  reconcileSecurityWatchWithVault,
} from "@opensesame/app-core/lib/vault/security-checks.js";
import { type ComponentType, useEffect, useSyncExternalStore } from "react";
import { useVault } from "../../lib/vault/hooks.js";
import { SecurityChecksPanelBody } from "./SecurityChecksPanelBody.js";

export type SecurityCheckFetches = {
  range: CheckFetch;
  twoFactor: CheckFetch;
};

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
    const { tomb, items } = vault;
    useEffect(() => {
      reconcileSecurityWatchWithVault(tomb, items);
    }, [tomb, items]);
    const watch = useSyncExternalStore(
      subscribeBreachWatch,
      breachWatchSnapshot,
      breachWatchSnapshot,
    );
    const open = vault.status === "unlocked";
    const label = statusLabel(watch);

    return (
      <SecurityChecksPanelBody
        watch={watch}
        label={label}
        open={open}
        vault={vault}
        fetches={fetches}
      />
    );
  };
}
