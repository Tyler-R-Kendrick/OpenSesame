/**
 * Tutorial-safe route registry.
 *
 * GuideLang's `navigate` takes a route *id*, not a URL. Only the destinations
 * declared here can be reached, and each is a non-mutating in-app view: no
 * ceremony is entered or left on the model's say-so, nothing is submitted, and
 * `javascript:`, `data:`, protocol-relative and traversal strings cannot
 * survive both the grammar's syntax check and this membership check.
 */

import { isGuideRouteId } from "@opensesame/guide-lang";
import type { SupportRouteDescription } from "@opensesame/support-agent";
import { SETTINGS_CATEGORIES, settingsPath } from "../../lib/crumbs.js";

export type GuideRouteId = string;

export type GuideRouteDescriptor = {
  readonly id: GuideRouteId;
  readonly title: string;
};

const SECTION_ROUTES: readonly GuideRouteDescriptor[] = [
  { id: "/unlock", title: "Unlock — open the vault or sign in" },
  { id: "/setup", title: "Setup — how people sign in to this deployment" },
  {
    id: "/broker/authorize",
    title: "Broker — approve a static site sign-in",
  },
  { id: "/federation", title: "Federation return — finish a sign-in" },
  { id: "/vault", title: "Vault — every item this deployment holds" },
  { id: "/vault/health", title: "Vault health — weak, reused and aging items" },
  {
    id: "/connections",
    title: "Connections — provider connections and their state",
  },
  { id: "/access", title: "Access — delegations, offers and running tasks" },
  {
    id: "/identity",
    title: "Identity — accounts, providers and linked identities",
  },
  { id: "/settings", title: "Settings — this deployment's preferences" },
];

const SETTINGS_ROUTES: readonly GuideRouteDescriptor[] =
  SETTINGS_CATEGORIES.map((category) => ({
    id: settingsPath(category),
    title: `Settings — ${category}`,
  }));

export const GUIDE_ROUTES: readonly GuideRouteDescriptor[] = [
  ...SECTION_ROUTES,
  ...SETTINGS_ROUTES,
];

const byId = new Map<GuideRouteId, GuideRouteDescriptor>();
for (const route of GUIDE_ROUTES) {
  if (!isGuideRouteId(route.id)) {
    throw new Error(`guide_route_syntax:${route.id}`);
  }
  byId.set(route.id, route);
}

export function isKnownGuideRoute(id: GuideRouteId): boolean {
  return byId.has(id);
}

export function describeGuideRoutes(): readonly SupportRouteDescription[] {
  return GUIDE_ROUTES.map((route) => ({ id: route.id, title: route.title }));
}

/**
 * Whether `route` lies within `scope` — the same question `guideRouteForPath`
 * asks of a pathname, asked of one declared route about another.
 *
 * The boundary matters. A bare `startsWith` makes `/access` a prefix of a
 * future `/access-review`, which would silently scope every `/access` target,
 * goal and help topic onto an unrelated screen and tell a model that controls
 * are present that are not. Nothing collides among the routes declared today,
 * so this buys no behaviour now and exists so that adding a hyphenated sibling
 * stays the harmless thing it looks like.
 */
export function guideRouteWithin(
  route: GuideRouteId,
  scope: GuideRouteId,
): boolean {
  return route === scope || route.startsWith(`${scope}/`);
}

/**
 * Longest declared route that prefixes the live pathname. Deep paths the
 * tutorial cannot name (`/vault/:itemId/edit`) still report their section, so
 * page context stays honest without widening what `navigate` may reach.
 */
export function guideRouteForPath(pathname: string): GuideRouteId {
  let best = "/vault";
  let bestLength = 0;
  for (const route of GUIDE_ROUTES) {
    if (
      (pathname === route.id || pathname.startsWith(`${route.id}/`)) &&
      route.id.length > bestLength
    ) {
      best = route.id;
      bestLength = route.id.length;
    }
  }
  return best;
}
