import { useCallback } from "react";
import { useSearchParams } from "react-router";

export const ACCESS_VIEWS = [
  "grants",
  "requests",
  "sessions",
  "resources",
  "policies",
] as const;
export const ACCESS_LABELS = {
  grants: "Grants",
  requests: "Requests",
  sessions: "Sessions",
  resources: "Resources",
  policies: "Policies",
} satisfies Record<(typeof ACCESS_VIEWS)[number], string>;
export const IDENTITY_VIEWS = [
  "people",
  "agents",
  "providers",
  "devices",
  "service-accounts",
  "organization",
] as const;
export const IDENTITY_LABELS = {
  people: "People",
  agents: "Agents",
  providers: "Providers",
  devices: "Devices",
  "service-accounts": "Applications",
  organization: "Organization",
} satisfies Record<(typeof IDENTITY_VIEWS)[number], string>;

/** One URL-backed selection for human tabs, deep links, and browser tools. */
export function useSectionView<T extends string>(
  views: readonly T[],
  fallback: T,
) {
  const [params, setParams] = useSearchParams();
  const selected =
    views.find((view) => view === params.get("view")) ?? fallback;
  const select = useCallback(
    (view: T) => {
      if (!views.includes(view)) throw new Error("unknown_view");
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set("view", view);
        return next;
      });
    },
    [setParams, views],
  );
  return [selected, select] as const;
}
