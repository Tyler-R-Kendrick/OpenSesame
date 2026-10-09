import { finishLinearAuthorization } from "@opensesame/app-core/lib/linear-connectors.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

/** Resume a Linear provider callback once; a second actor's consent keeps its redirect. */
export function useLinearCallback(
  search: string,
  loadConnections: () => Promise<void>,
  onFlash: (flash: Flash) => void,
): void {
  const navigate = useNavigate();
  const linearReturn = useRef<string | null>(null);
  useEffect(() => {
    if (
      !new URLSearchParams(search).has("linear_state") ||
      linearReturn.current === search
    )
      return;
    linearReturn.current = search;
    void finishLinearAuthorization(search)
      .then(async (connection) => {
        if (!connection) return;
        await loadConnections();
        navigate(`/connections/linear/${connection.connectionId}`, {
          replace: true,
        });
        onFlash({
          tone: connection.status === "active" ? "ok" : "warn",
          text:
            connection.status === "active"
              ? `Linear connected to ${connection.accountLabel ?? "your workspace"}.`
              : (connection.statusDetail ??
                "Complete the remaining Linear authorization."),
        });
      })
      .catch((error) => {
        onFlash({ tone: "err", text: errorText(error) });
        void loadConnections();
      });
  }, [search, loadConnections, navigate, onFlash]);
}
