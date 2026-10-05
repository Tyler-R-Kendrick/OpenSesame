import {
  GUIDE_OVERLAY_ROUTES,
  type GuideRouteId,
  guideRouteForLocation,
} from "@opensesame/app-core/tutorial/registry/routes.js";
import { guideNavigationPath } from "@opensesame/app-core/tutorial/registry/vault-routes.js";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import type { SupportController } from "./session.js";

/**
 * Keeps the support controller's idea of where the person is, and how a tour
 * moves them, in step with the router. The route is read to the precision a
 * tour needs — an item's pane and the trash are places of their own, though
 * neither is a path (`guideRouteForLocation`) — and a tour's `navigate` is
 * resolved the same way (`guideNavigationPath`). A gate screen is never
 * navigated to: it is declared by `useSupportRoute`, not entered by a tour.
 */
export function useSupportRouteSync(
  controller: SupportController,
  override: GuideRouteId | null,
): void {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    controller.setRoute(
      override ?? guideRouteForLocation(location.pathname, location.search),
    );
  }, [controller, location.pathname, location.search, override]);

  useEffect(() => {
    controller.setNavigator((route) => {
      if (GUIDE_OVERLAY_ROUTES.has(route)) return;
      const path = guideNavigationPath(route, location);
      if (path !== null) navigate(path);
    });
  }, [controller, navigate, location]);
}
