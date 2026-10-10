import {
  type PendingRequest,
  listCliIntegrationPending,
} from "@opensesame/app-core/lib/cli-app-integration/index.js";
import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/policy.js";
import { mayPairLocalAuthority } from "@opensesame/app-core/lib/deployment-profile.js";
import { type ReactNode, useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";
import { CliAuthorizeSheet } from "./CliAuthorizeSheet.js";

export const cliAuthorizeHostSeams = {
  eligible: mayPairLocalAuthority,
  listPending: listCliIntegrationPending,
};

/** Polls the daemon while the vault is unlocked and opens the authorize sheet. */
export function CliAuthorizeHost({
  children,
}: {
  children?: ReactNode;
}) {
  const { status } = useVault();
  const [pending, setPending] = useState<PendingRequest | null>(null);

  useEffect(() => {
    if (status !== "unlocked" || !cliAuthorizeHostSeams.eligible()) {
      setPending(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      void cliAuthorizeHostSeams.listPending().then((rows) => {
        if (cancelled) return;
        setPending((current) => {
          if (rows.length === 0) return null;
          if (current) {
            const still = rows.find(
              (row) => row.requestId === current.requestId,
            );
            return still ?? rows[0] ?? null;
          }
          return rows[0] ?? null;
        });
      });
    };
    tick();
    const timer = setInterval(tick, cliAppIntegrationPolicy.pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status]);

  return (
    <>
      {children}
      {pending ? (
        <CliAuthorizeSheet
          request={pending}
          onClose={() => setPending(null)}
          onSettled={() => setPending(null)}
        />
      ) : null}
    </>
  );
}
