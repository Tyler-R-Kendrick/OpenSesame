export type InboxStatusFilter = "pending" | "expired" | "decided" | "all";

export type InboxRow = {
  id: string;
  status: string;
  expiresAt?: string;
  plane: "local" | "hosted";
};

export function classifyInboxStatus(
  row: InboxRow,
  now: number = Date.now(),
): "pending" | "expired" | "decided" {
  if (row.status === "pending") {
    if (row.expiresAt && Date.parse(row.expiresAt) <= now) return "expired";
    return "pending";
  }
  return "decided";
}

export function filterInboxRows(
  rows: readonly InboxRow[],
  filter: InboxStatusFilter,
  now: number = Date.now(),
): InboxRow[] {
  if (filter === "all") return [...rows];
  return rows.filter((row) => classifyInboxStatus(row, now) === filter);
}
