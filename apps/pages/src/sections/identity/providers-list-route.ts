/** URL for Identity › Providers list, ceremony, and record selection. */
export function providersListRoute(
  query: { action?: "new" },
  recordId?: string,
): { pathname: string; search: string; hash: string } {
  const search = new URLSearchParams({ view: "providers" });
  if (query.action === "new") search.set("action", "new");
  return {
    pathname: "/identity",
    search: `?${search.toString()}`,
    hash: recordId ? `#${encodeURIComponent(recordId)}` : "",
  };
}
