import {
  type Unregister,
  createWebMcpRegistrar,
  detectModelContext,
} from "@opensesame/webmcp";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { WEBMCP_TOOLS, webmcpNavigationSeam } from "./tools.js";

const APP_ID = "opensesame-pages";

export type WebMcpRouter = { navigate: (to: string) => void };

function registerScope(scope: "boot" | "session"): Unregister {
  const registrar = createWebMcpRegistrar(detectModelContext(), {
    appId: APP_ID,
  });
  return registrar.register(WEBMCP_TOOLS.filter((t) => t.scope === scope));
}

/**
 * Boot tools (status, navigate, health) live for as long as the app is
 * mounted; the returned unregister also detaches the router seam.
 */
export function registerBootTools(router: WebMcpRouter): Unregister {
  const previous = webmcpNavigationSeam.navigate;
  webmcpNavigationSeam.navigate = router.navigate;
  const unregister = registerScope("boot");
  return () => {
    unregister();
    webmcpNavigationSeam.navigate = previous;
  };
}

/** Session tools exist only between vault unlock and lock/sign-out. */
export function registerSessionTools(): Unregister {
  return registerScope("session");
}

/**
 * Wires WebMCP into the app. Where `navigator.modelContext` is absent every
 * registration is a silent no-op, so browsers without WebMCP see no change.
 */
export function useWebMcp(vaultStatus: string): void {
  const navigate = useNavigate();

  useEffect(
    () =>
      registerBootTools({
        navigate: (to) => {
          void navigate(to);
        },
      }),
    [navigate],
  );

  useEffect(() => {
    if (vaultStatus !== "unlocked") return;
    return registerSessionTools();
  }, [vaultStatus]);
}
