import {
  type Unregister,
  createWebMcpRegistrar,
  detectModelContext,
} from "@opensesame/webmcp";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import {
  noteWebMcpFailure,
  noteWebMcpRegistered,
  noteWebMcpUnregistered,
} from "./registration.js";
import {
  WEBMCP_TOOLS,
  type WebMcpSupportSeam,
  webmcpNavigationSeam,
  webmcpSupportSeam,
} from "./tools.js";

const APP_ID = "opensesame-pages";

export type WebMcpRouter = { navigate: (to: string) => void };

function registerScope(scope: "boot" | "session"): Unregister {
  const api = detectModelContext();
  const registrar = createWebMcpRegistrar(api, {
    appId: APP_ID,
    onFailure: noteWebMcpFailure,
  });
  const tools = WEBMCP_TOOLS.filter((t) => t.scope === scope);
  const unregister = registrar.register(tools);
  noteWebMcpRegistered(
    api?.source ?? null,
    scope,
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      scope,
    })),
  );
  return () => {
    unregister();
    noteWebMcpUnregistered(scope);
  };
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
 *
 * The boot registration runs once per mount. `useNavigate` hands out a new
 * function whenever the location changes, and an effect keyed on it would
 * re-register every boot tool on every route — which the browser answers by
 * refusing the duplicate name. The router is reached through a ref instead,
 * so the tools stay registered and always navigate with the current router.
 */
export function useWebMcp(vaultStatus: string): void {
  const navigate = useNavigate();
  const router = useRef(navigate);
  router.current = navigate;

  useEffect(
    () =>
      registerBootTools({
        navigate: (to) => {
          void router.current(to);
        },
      }),
    [],
  );

  useEffect(() => {
    if (vaultStatus !== "unlocked") return;
    return registerSessionTools();
  }, [vaultStatus]);
}
