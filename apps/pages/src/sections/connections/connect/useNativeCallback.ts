import { finishNativeBrowserAuthorization } from "@opensesame/app-core/lib/native-browser-oauth-connectors.js";
import { finishNativeMcpAuthorization } from "@opensesame/app-core/lib/native-mcp-connectors.js";
import { nativeOAuthCallbackTarget } from "@opensesame/app-core/lib/native-oauth-session.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

/** Only the sealed single-use state selects a provider or authorization method. */
export function useNativeCallback(
  search: string,
  reload: () => Promise<void>,
  onFlash: (flash: Flash) => void,
): void {
  const navigate = useNavigate();
  const handled = useRef<string | null>(null);
  const activeSearch = useRef(search);
  activeSearch.current = search;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (
      !new URLSearchParams(search).has("native_state") ||
      handled.current === search
    )
      return;
    handled.current = search;
    const resume = async () => {
      const target = nativeOAuthCallbackTarget(search);
      if (!target)
        throw new Error(
          "This provider callback has expired or was already used",
        );
      if (target.method !== "mcp" && target.method !== "oauth")
        throw new Error(
          "This callback does not match a provider authorization method",
        );
      const finish =
        target.method === "mcp"
          ? finishNativeMcpAuthorization
          : finishNativeBrowserAuthorization;
      const view = await finish(search);
      if (!mounted.current || activeSearch.current !== search) return;
      await reload();
      if (!mounted.current || activeSearch.current !== search) return;
      navigate(
        `/connections/${encodeURIComponent(target.providerId)}/${encodeURIComponent(target.connectionId)}`,
        { replace: true },
      );
      onFlash({
        tone: view?.status === "connected" ? "ok" : "warn",
        text:
          view?.status === "connected"
            ? "Provider access verified and saved on this device."
            : "Complete provider authorization or recovery for this connection.",
      });
    };
    void resume().catch((error) => {
      if (!mounted.current || activeSearch.current !== search) return;
      navigate("/connections", { replace: true });
      onFlash({ tone: "err", text: errorText(error) });
      void reload();
    });
  }, [search, reload, navigate, onFlash]);
}
