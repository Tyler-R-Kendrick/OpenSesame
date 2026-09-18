export type SavedView = {
  id: string;
  name: string;
  collection: "vault" | "approvals" | "sessions" | "applications";
  scopeKey: string;
  predicates: Record<string, string>;
  sort?: string;
  columns?: readonly string[];
};

export type ViewResolution =
  | { ok: true; view: SavedView }
  | { ok: false; reason: "scope" | "unknown" | "unsupported" };

const PROVIDER_FILTERS = {
  vault: ["kind", "folder", "favorite", "query"],
  approvals: ["status", "plane", "scope"],
  sessions: ["kind", "owner"],
  applications: ["plane", "query"],
} satisfies Record<SavedView["collection"], readonly string[]>;

export function validateSavedView(view: SavedView): ViewResolution {
  const allowed = PROVIDER_FILTERS[view.collection];
  for (const key of Object.keys(view.predicates)) {
    if (!allowed.includes(key)) {
      return { ok: false, reason: "unsupported" };
    }
  }
  return { ok: true, view };
}

/** A view is a query. Changing scope drops cached results. */
export function resolveSavedView(
  view: SavedView,
  currentScopeKey: string,
): ViewResolution {
  const validated = validateSavedView(view);
  if (!validated.ok) return validated;
  if (view.scopeKey !== currentScopeKey) return { ok: false, reason: "scope" };
  return validated;
}

export function viewSharesNoGrant(view: SavedView): boolean {
  return !("grant" in view.predicates) && !("token" in view.predicates);
}
