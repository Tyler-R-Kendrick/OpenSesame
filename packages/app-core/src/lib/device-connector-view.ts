/** Public device rows render without loading any optional provider runtime or private credentials. */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import type { Connection } from "./connections.js";
import type { PublicRow } from "./device-connector-records.js";

type AuthorizationView = Pick<
  Connection,
  | "status"
  | "statusDetail"
  | "grantedScopes"
  | "accountLabel"
  | "expiresAt"
  | "refreshable"
>;

function grantedScopes(raw: string | undefined): string[] {
  try {
    const parsed: BoundaryValue = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const scopes: string[] = [];
    for (const value of parsed) {
      if (!isString(value)) return [];
      scopes.push(value);
    }
    return scopes;
  } catch {
    return [];
  }
}

function authorizationView(row: PublicRow): AuthorizationView {
  const ordinary: AuthorizationView = {
    status: "active",
    statusDetail: null,
    grantedScopes: row.scopes,
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
  };
  if (row.fields.self_hosted_configuration === undefined) return ordinary;
  if (row.providerId !== "linear" || row.fields.linear_verified !== "1") {
    return {
      ...ordinary,
      status: "pending",
      statusDetail: "Configured on this device; authorization required",
      grantedScopes: [],
    };
  }
  return {
    ...ordinary,
    grantedScopes: grantedScopes(row.fields.linear_granted_scopes),
    accountLabel: row.fields.linear_account ?? null,
    expiresAt: row.fields.linear_expires_at || null,
    refreshable: row.fields.linear_refreshable === "1",
  };
}

export function deviceConnectorView(row: PublicRow): Connection {
  return {
    connectionId: row.connectionId,
    connectionRef: `local/connector/${row.connectionId}`,
    logicalName: row.connectionId,
    displayName: row.displayName,
    providerId: row.providerId,
    integrationId: null,
    ...authorizationView(row),
    organizationId: "local",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: row.scopes,
    lastRefreshedAt: null,
    maxInvokeLevel: 0,
    egress: { scheme: "none", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
