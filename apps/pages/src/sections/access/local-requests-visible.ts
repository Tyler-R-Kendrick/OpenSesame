import {
  type InboxStatusFilter,
  filterInboxRows,
} from "@opensesame/app-core/lib/configuration/inbox-triage.js";
import type { LocalAccessRequest } from "@opensesame/app-core/lib/local-access-requests.js";
import type { LocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import type { PendingShare } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import { grantRowId } from "./local-requests-selection.js";

export function requestWorkspaceRows(
  rows: readonly LocalAccessRequest[],
  directory: LocalDirectory | undefined,
  path: (id: string) => string,
) {
  return rows.map((row) => ({
    id: row.id,
    label:
      directory?.entries.find((entry) => entry.id === row.applicationId)
        ?.name ?? row.applicationId,
    extension: "request",
    to: path(row.id),
  }));
}

export function visiblePendingGrants(
  grants: PendingShare[] | undefined,
  directory: LocalDirectory | undefined,
  statusFilter: InboxStatusFilter,
  path: (id: string) => string,
) {
  if (!grants?.length) return [];
  if (statusFilter !== "all" && statusFilter !== "pending") return [];
  const name = (principalId: string) =>
    directory?.entries.find((entry) => entry.id === principalId)?.name ??
    principalId;
  return grants.map((row) => ({
    id: grantRowId(row.id),
    label: `${name(row.principalId)} → ${row.resourceLabel}`,
    extension: "grant",
    to: path(grantRowId(row.id)),
  }));
}

export function visibleRequests(
  requests: LocalAccessRequest[] | undefined,
  statusFilter: InboxStatusFilter,
) {
  const visibleIds = new Set(
    filterInboxRows(
      (requests ?? []).map((row) => ({
        id: row.id,
        status: row.status,
        expiresAt: new Date(row.expiresAt).toISOString(),
        plane: "local" as const,
      })),
      statusFilter,
    ).map((row) => row.id),
  );
  return (requests ?? []).filter((row) => visibleIds.has(row.id));
}
