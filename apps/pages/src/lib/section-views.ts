import { useCallback } from "react";
import { useSearchParams } from "react-router";

export const ACCESS_VIEWS = [
  "grants",
  "requests",
  "sessions",
  "resources",
  "policies",
] as const;
export const IDENTITY_VIEWS = [
  "people",
  "providers",
  "devices",
  "service-accounts",
  "organization",
] as const;

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
