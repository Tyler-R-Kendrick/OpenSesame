import {
  fetchFirstCliAppPending,
  readCliAppAuthHeaders,
  readDaemonOrigin,
} from "@opensesame/app-core/lib/cli-app-integration/client.js";
import { useEffect } from "react";
import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/policy-runtime.js";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import type { CliAuthorizePanelHint } from "./cli-authorize-panel-model.js";

function toAuthorizeRow(
  row: NonNullable<Awaited<ReturnType<typeof fetchFirstCliAppPending>>>,
): CliAuthorizeRow {
  return [row.requestId, row.terminalSessionId, row.verb, row.respondNonce];
}

export function useCliAuthorizePendingPoll(
  setRow: (row: CliAuthorizeRow | null | undefined) => void,
  setHint: (hint: CliAuthorizePanelHint) => void,
): void {
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const origin = readDaemonOrigin();
      const headers = readCliAppAuthHeaders();
      if (!origin) {
        if (!cancelled) {
          setRow(null);
          setHint("daemon-unreachable");
        }
        return;
      }
      if (!headers) {
        if (!cancelled) {
          setRow(null);
          setHint("unpaired");
        }
        return;
      }
      try {
        const pending = await fetchFirstCliAppPending();
        if (!cancelled) {
          setHint(null);
          setRow(pending ? toAuthorizeRow(pending) : null);
        }
      } catch (error) {
        if (cancelled) return;
        setRow(null);
        if (error instanceof DOMException && error.name === "SecurityError") {
          setHint("local-network-blocked");
        } else {
          setHint("daemon-unreachable");
        }
      }
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, cliAppIntegrationPolicy.pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [setHint, setRow]);
}
