/**
 * Pure Connect row → Connection mapping (keeps vercel-connect.ts under budget).
 */
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import type { Connection, Egress } from "./connections.js";

export type ConnectAuthLike = {
  token?: string;
  teamId?: string;
  projectId?: string;
};

const EMPTY_EGRESS = {
  scheme: "https",
  authorities: [],
  pathPrefixes: [],
} satisfies Egress;

export function text(value: BoundaryValue | undefined, max = 256): string {
  return isString(value) ? value.slice(0, max) : "";
}

export function iso(value: BoundaryValue | undefined): string {
  if (isNumber(value) && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  const raw = text(value);
  if (!raw) return "";
  const numeric = Number(raw);
  const ms =
    Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(raw);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

function scopeNames(value: BoundaryValue | undefined): string[] {
  if (!isJsonObject(value) || !Array.isArray(value.scopes)) return [];
  return value.scopes.filter(isString).slice(0, 64);
}

export function rows(value: BoundaryValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  const out: JsonObject[] = [];
  for (const item of value) {
    if (isJsonObject(item)) out.push(item);
    if (out.length === 100) break;
  }
  return out;
}

export function connectorOf(value: BoundaryValue): JsonObject | null {
  if (isJsonObject(value) && isJsonObject(value.connector))
    return value.connector;
  return isJsonObject(value) ? value : null;
}

function egressOf(row: JsonObject): Connection["egress"] {
  const raw = text(row.clientUrl) || text(row.website);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return EMPTY_EGRESS;
    return { scheme: "https", authorities: [url.host], pathPrefixes: [] };
  } catch {
    return EMPTY_EGRESS;
  }
}

export function toConnectConnection(
  row: JsonObject,
  auth: ConnectAuthLike,
): Connection | null {
  const id =
    text(row.id, 128) || text(row.uid, 128) || text(row.connectorId, 128);
  if (!id) return null;
  const service = text(row.service, 128) || id;
  const createdAt = iso(row.createdAt);
  return {
    connectionId: id,
    connectionRef: `connect://${text(row.uid, 128) || id}`,
    logicalName: text(row.uid, 128) || text(row.name, 128) || service,
    displayName: text(row.displayName) || text(row.name) || service,
    providerId: service,
    integrationId: null,
    status: row.reinstallAt ? "needs_reauth" : "active",
    statusDetail: null,
    organizationId: auth.teamId || "",
    projectId: auth.projectId || null,
    ownerKind: "organization",
    shareability: "delegable",
    requestedScopes: [],
    grantedScopes: [
      ...scopeNames(row.userTokens),
      ...scopeNames(row.appTokens),
    ],
    accountLabel: text(row.name) || null,
    expiresAt: null,
    refreshable: true,
    lastRefreshedAt: null,
    maxInvokeLevel: 2,
    egress: egressOf(row),
    bindings: [],
    createdAt,
    updatedAt: iso(row.updatedAt) || createdAt,
  };
}
