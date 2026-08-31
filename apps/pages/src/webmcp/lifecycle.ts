import {
  type Unregister,
  createWebMcpRegistrar,
  detectModelContext,
} from "@opensesame/webmcp";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import {
  WEBMCP_TOOLS,
  type WebMcpSupportSeam,
  webmcpNavigationSeam,
  webmcpSupportSeam,
} from "./tools.js";

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
 * Binds the live support surface for as long as the panel that owns it is
 * mounted, the way `registerBootTools` binds the router. The panel decides
 * what opening support and starting a walkthrough mean; the tools only check
 * that the caller named an authored topic or goal and then call through here.
 */
export function bindWebMcpSupport(support: WebMcpSupportSeam): Unregister {
  const previous: WebMcpSupportSeam = {
    openSupport: webmcpSupportSeam.openSupport,
    startGuide: webmcpSupportSeam.startGuide,
  };
  webmcpSupportSeam.openSupport = support.openSupport;
  webmcpSupportSeam.startGuide = support.startGuide;
  return () => {
    webmcpSupportSeam.openSupport = previous.openSupport;
    webmcpSupportSeam.startGuide = previous.startGuide;
  };
}

/**
 * Wires WebMCP into the app. Where neither `document.modelContext` nor the
 * legacy `navigator.modelContext` is present every
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
