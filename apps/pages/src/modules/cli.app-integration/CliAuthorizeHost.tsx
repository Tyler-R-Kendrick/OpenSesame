import type { PendingRequest } from "@opensesame/app-core/lib/cli-app-integration/pending-request.js";
const CLI_POLL_INTERVAL_MS = 500;
import { mayPairLocalAuthority } from "@opensesame/app-core/lib/deployment-profile.js";
import { type ReactNode, useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";
import { listCliIntegrationPending } from "./cli-daemon-client.js";
import { CliAuthorizeSheet } from "./cli-authorize-sheet.js";

export const cliAuthorizeHostSeams = {
  eligible: mayPairLocalAuthority,
  listPending: listCliIntegrationPending,
};

/** Polls the daemon while the vault is unlocked and opens the authorize sheet. */
export function CliAuthorizeHost({ children }: { children?: ReactNode }) {
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
    const timer = setInterval(tick, CLI_POLL_INTERVAL_MS);
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
