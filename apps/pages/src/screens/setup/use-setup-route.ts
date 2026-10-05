/**
 * Which part of setup is on screen, for the help key it draws (ADR 0165): the
 * choice of a configuration, or one tab of the ceremony. A tab with a tutorial
 * of its own reports its own route, so that tour is offered while its panel is
 * drawn and not on a tab where it would point at nothing; any other tab
 * reports setup itself.
 */

import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import { useSupportRoute } from "../../tutorial/session.js";

const TAB_ROUTES: Readonly<Record<string, GuideRouteId>> = {
  capabilities: "/setup/capabilities",
  identity: "/setup/identity",
  connectors: "/setup/connectors",
};

export function setupRoute(
  phase: "choose" | "ceremony",
  tab: string | undefined,
): GuideRouteId {
  if (phase === "choose") return "/setup/choose";
  if (tab === undefined) return "/setup";
  return TAB_ROUTES[tab] ?? "/setup";
}

export function useSetupRoute(
  phase: "choose" | "ceremony",
  tab: string | undefined,
): void {
  useSupportRoute(setupRoute(phase, tab));
}
