/** Public device rows render without loading any optional provider runtime or private credentials. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { Connection } from "./connections.js";
import { type PublicRow, readDeviceRows } from "./device-connector-records.js";
import { identityConnectionDeviceSeams } from "./identity-connections-seam.js";
import { secretBackendDeviceSeams } from "./secret-backends/seam.js";
import { tailscaleNodeAuthorization } from "./tailscale/browser-node-port.js";

type AuthorizationView = Pick<
  Connection,
  | "status"
  | "statusDetail"
  | "grantedScopes"
  | "accountLabel"
  | "expiresAt"
  | "refreshable"
>;

/** Installed only by the optional provider runtime; inactive records stay pending. */
type NativeDeviceViewPort = {
  authorization: (connectionId: string) => AuthorizationView | null;
};
export const nativeDeviceViewSeams: NativeDeviceViewPort = {
  authorization: () => null,
};

/** Bound by `byo-connections.ts`; absent means the item cannot be checked. */
export const byoConnectionViewSeams = {
  itemExists: (_itemId: string): boolean => false,
};

function byoItemId(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed) || !isString(parsed.itemId)) return null;
    return parsed.itemId;
  } catch {
    return null;
  }
}

function byoAuthorization(
  row: PublicRow,
  ordinary: AuthorizationView,
): AuthorizationView {
  const itemId = byoItemId(row.fields.byo_connection);
  if (!itemId || !byoConnectionViewSeams.itemExists(itemId)) {
    return {
      ...ordinary,
      status: "pending",
      statusDetail:
        "The credential item for this connection is unavailable on this device.",
      grantedScopes: [],
    };
  }
  return {
    ...ordinary,
    status: "active",
    statusDetail:
      "Credentials are stored in this vault; no broker session is configured.",
    grantedScopes: [],
  };
}

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

function tailscaleAuthorization(
  row: PublicRow,
  ordinary: AuthorizationView,
): AuthorizationView {
  if (
    row.fields.native_configuration !== undefined &&
    row.fields.tailscale_browser_node === undefined &&
    row.fields.self_hosted_configuration !== "tailscale-browser-v1"
  )
    return (
      nativeDeviceViewSeams.authorization(row.connectionId) ?? {
        ...ordinary,
        status: "pending",
        statusDetail: "Verify this saved Tailscale configuration",
        grantedScopes: [],
      }
    );
  const node = tailscaleNodeAuthorization();
  const connected = node?.connectionId === row.connectionId && node.connected;
  return {
    ...ordinary,
    status: connected ? "active" : "pending",
    statusDetail: connected
      ? "Browser node connected"
      : "Browser node not connected",
    grantedScopes: [],
  };
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
  if (row.providerId === "tailscale")
    return tailscaleAuthorization(row, ordinary);
  if (row.fields.byo_connection !== undefined)
    return byoAuthorization(row, ordinary);
  if (row.fields.self_hosted_configuration === undefined) return ordinary;
  if (row.fields.secret_backend_configuration !== undefined) {
    return (
      secretBackendDeviceSeams.authorization(row.connectionId) ?? {
        ...ordinary,
        status: "pending",
        statusDetail: "Configured; connect to access items",
        grantedScopes: [],
      }
    );
  }
  if (row.fields.identity_configuration !== undefined) {
    return (
      identityConnectionDeviceSeams.authorization(row.connectionId) ?? {
        ...ordinary,
        status: "pending",
        statusDetail: "Configured; sign in to verify identity",
        grantedScopes: [],
      }
    );
  }
  if (row.fields.native_configuration !== undefined) {
    return (
      nativeDeviceViewSeams.authorization(row.connectionId) ?? {
        ...ordinary,
        status: "pending",
        statusDetail: "Enable External connectors to verify this connection",
        grantedScopes: [],
      }
    );
  }
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

/** Recognize the public native marker without reading sealed credentials or loading a driver. */
export function isNativeDeviceConnection(connection: Connection): boolean {
  if (connection.connectionRef !== `local/connector/${connection.connectionId}`)
    return false;
  return readDeviceRows().some(
    (row) =>
      row.connectionId === connection.connectionId &&
      (row.fields.native_configuration !== undefined ||
        row.providerId === "tailscale"),
  );
}

/** Route labels use saved public metadata, never provider authority or URL identifiers. */
export function deviceConnectorDisplayName(
  providerId: string,
  connectionId: string,
): string | undefined {
  return readDeviceRows().find(
    (row) => row.providerId === providerId && row.connectionId === connectionId,
  )?.displayName;
}
