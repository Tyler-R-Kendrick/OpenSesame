/**
 * Tutorial-safe route registry.
 *
 * GuideLang's `navigate` takes a route *id*, not a URL. Only the destinations
 * declared here can be reached, and each is a non-mutating in-app view: no
 * ceremony is entered or left on the model's say-so, nothing is submitted, and
 * `javascript:`, `data:`, protocol-relative and traversal strings cannot
 * survive both the grammar's syntax check and this membership check.
 */

import type { SupportRouteDescription } from "@opensesame/support-agent";
import { contributionsSnapshot } from "../../lib/contributions.js";
import { SETTINGS_CATEGORIES, settingsPath } from "../../lib/crumbs.js";

export type GuideRouteId = string;

export type GuideRouteDescriptor = {
  readonly id: GuideRouteId;
  readonly title: string;
};

const SECTION_ROUTES: readonly GuideRouteDescriptor[] = [
  { id: "/unlock", title: "Unlock — open the vault or sign in" },
  {
    id: "/setup",
    title: "Setup — connectors, sign-in and backups for this deployment",
  },
  {
    id: "/broker/authorize",
    title: "Broker — approve a static site sign-in",
  },
  { id: "/vault", title: "Vault — every item this deployment holds" },
  { id: "/vault/health", title: "Vault health — weak, reused and aging items" },
  { id: "/settings", title: "Settings — this deployment's preferences" },
];

function settingsRoute(category: string): GuideRouteDescriptor {
  return { id: settingsPath(category), title: `Settings — ${category}` };
}

const SETTINGS_ROUTES: readonly GuideRouteDescriptor[] =
  SETTINGS_CATEGORIES.map(settingsRoute);

/**
 * The routes the core shell always has. An optional section's routes arrive
 * as `tutorial-route` contributions, and a contributed settings category
 * brings its `/settings/<id>` route with it.
 */
export const CORE_GUIDE_ROUTES: readonly GuideRouteDescriptor[] = [
  ...SECTION_ROUTES,
  ...SETTINGS_ROUTES,
];

let contributedRoutes: readonly GuideRouteDescriptor[] | null = null;
let contributedCategories: readonly { id: string }[] | null = null;
const byId = new Map<GuideRouteId, GuideRouteDescriptor>();

/** The live routes: core plus contributed. A live binding; see `mergedGuideRoutes`. */
export let GUIDE_ROUTES: readonly GuideRouteDescriptor[] = CORE_GUIDE_ROUTES;

// Route-id syntax (`isGuideRouteId` from @opensesame/guide-lang) is asserted
// in `routes.test.ts`, not here: this registry sits on the shell's path via
// `useGuideTarget`, and the guide grammar belongs to `support.guided-help`.
function reindex(routes: readonly GuideRouteDescriptor[]): void {
  byId.clear();
  for (const route of routes) {
    if (!byId.has(route.id)) byId.set(route.id, route);
  }
}

export function mergedGuideRoutes(): readonly GuideRouteDescriptor[] {
  const routes = contributionsSnapshot("tutorial-route");
  const categories = contributionsSnapshot("settings-category");
  if (routes === contributedRoutes && categories === contributedCategories) {
    return GUIDE_ROUTES;
  }
  contributedRoutes = routes;
  contributedCategories = categories;
  const extra: GuideRouteDescriptor[] = [
    ...routes,
    ...categories.map((category) => settingsRoute(category.id)),
  ];
  const seen = new Set(CORE_GUIDE_ROUTES.map((route) => route.id));
  const added = extra.filter((route) => {
    if (seen.has(route.id)) return false;
    seen.add(route.id);
    return true;
  });
  GUIDE_ROUTES =
    added.length === 0
      ? CORE_GUIDE_ROUTES
      : Object.freeze([...CORE_GUIDE_ROUTES, ...added]);
  reindex(GUIDE_ROUTES);
  return GUIDE_ROUTES;
}

/** Named by `useSupportRoute`; a guide may wait on them, never navigate to them. */
export const GUIDE_OVERLAY_ROUTES: ReadonlySet<GuideRouteId> = new Set([
  "/unlock",
  "/setup",
  "/broker/authorize",
  "/federation",
  "/identity/authorize",
]);

reindex(CORE_GUIDE_ROUTES);

export function isKnownGuideRoute(id: GuideRouteId): boolean {
  mergedGuideRoutes();
  return byId.has(id);
}

export function describeGuideRoutes(): readonly SupportRouteDescription[] {
  return mergedGuideRoutes().map((route) => ({
    id: route.id,
    title: route.title,
  }));
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
  for (const route of mergedGuideRoutes()) {
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
