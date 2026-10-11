/**
 * The Add-a-model-provider sheet over the Connections page (ADR 0188): which
 * provider's connections the route is about, whether it opens the sheet rather
 * than a page of its own, and where closing it or connecting lands.
 */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { useNavigate } from "react-router";
import { aiProviderSheetTarget } from "./ai-provider-sheet-target.js";

type Options = Readonly<{
  providerId: string | undefined;
  connectionId: string | undefined;
  pathname: string;
  providers: readonly Provider[] | null;
  /** `null` until the list has loaded: no sheet is decided before then. */
  connections: readonly Connection[] | null;
  reload: () => Promise<void>;
}>;

export function useAiSheet({
  providerId,
  connectionId,
  pathname,
  providers,
  connections,
  reload,
}: Options) {
  const navigate = useNavigate();
  const provider = providers?.find((item) => item.id === providerId) ?? null;
  const providerConnections = (connections ?? []).filter(
    (item) => item.providerId === providerId && item.status !== "revoked",
  );
  const target =
    providerId && connections !== null
      ? aiProviderSheetTarget({
          provider,
          connections: providerConnections,
          connectionId,
          pathname,
        })
      : null;
  return {
    provider,
    providerConnections,
    target,
    close: () => navigate("/connections"),
    connected: () => {
      void reload();
      navigate("/connections");
    },
  };
}
