/**
 * The daemon's answers (ADR 0169 §4), parsed into what the panels draw.
 * Every field is read defensively: a missing string is "", a missing flag is
 * false, a list holds strings only and is capped, and an entry with no valid
 * id is dropped rather than drawn. A key's secret is read in exactly one
 * place, `parseCreatedKey`.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { type TailnetRole, isTailnetRole } from "./pairing.js";

const ID = /^[A-Za-z0-9]{1,64}$/;
const MAX_LIST = 256;

export type TailnetDevice = Readonly<{
  id: string;
  name: string;
  hostname: string;
  os: string;
  clientVersion: string;
  updateAvailable: boolean;
  user: string;
  addresses: readonly string[];
  tags: readonly string[];
  authorized: boolean;
  external: boolean;
  ephemeral: boolean;
  keyExpiryDisabled: boolean;
  expires: string | null;
  created: string | null;
  lastSeen: string | null;
  connected: boolean;
  blocksIncoming: boolean;
  sshEnabled: boolean;
  multipleConnections: boolean;
  advertisedRoutes: readonly string[];
  enabledRoutes: readonly string[];
  tailnetLockError: string | null;
}>;

export type TailnetKey = Readonly<{
  id: string;
  description: string;
  created: string | null;
  expires: string | null;
  revoked: string | null;
  invalid: boolean;
  reusable: boolean;
  ephemeral: boolean;
  preauthorized: boolean;
  tags: readonly string[];
}>;

/** A key just minted: the one place its secret appears. */
export type CreatedTailnetKey = TailnetKey & Readonly<{ key: string }>;

export type TailnetStatus = Readonly<{
  connected: boolean;
  tailnet: string;
  credential: "oauth" | "api_key" | null;
  role: TailnetRole;
  label: string;
}>;

export type TailnetAuditEntry = Readonly<{
  at: number;
  pairing: string;
  label: string;
  origin: string;
  action: string;
  target: string;
  status: number;
}>;

export type TailnetRoutes = Readonly<{
  advertisedRoutes: readonly string[];
  enabledRoutes: readonly string[];
}>;

function text(value: BoundaryValue): string {
  return isString(value) ? value.slice(0, 255) : "";
}

function when(value: BoundaryValue): string | null {
  return isString(value) && value !== "" ? value.slice(0, 64) : null;
}

function flag(value: BoundaryValue): boolean {
  return isBoolean(value) && value;
}

function strings(value: BoundaryValue): readonly string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (out.length >= MAX_LIST) break;
    if (isString(item)) out.push(item.slice(0, 255));
  }
  return out;
}

function idOf(raw: JsonObject): string | null {
  return isString(raw.id) && ID.test(raw.id) ? raw.id : null;
}

export function parseDevice(raw: BoundaryValue): TailnetDevice | null {
  if (!isJsonObject(raw)) return null;
  const id = idOf(raw);
  if (!id) return null;
  return {
    id,
    name: text(raw.name),
    hostname: text(raw.hostname),
    os: text(raw.os),
    clientVersion: text(raw.client_version),
    updateAvailable: flag(raw.update_available),
    user: text(raw.user),
    addresses: strings(raw.addresses),
    tags: strings(raw.tags),
    authorized: flag(raw.authorized),
    external: flag(raw.external),
    ephemeral: flag(raw.ephemeral),
    keyExpiryDisabled: flag(raw.key_expiry_disabled),
    expires: when(raw.expires),
    created: when(raw.created),
    lastSeen: when(raw.last_seen),
    connected: flag(raw.connected),
    blocksIncoming: flag(raw.blocks_incoming),
    sshEnabled: flag(raw.ssh_enabled),
    multipleConnections: flag(raw.multiple_connections),
    advertisedRoutes: strings(raw.advertised_routes),
    enabledRoutes: strings(raw.enabled_routes),
    tailnetLockError: when(raw.tailnet_lock_error),
  };
}

function listOf<T>(
  raw: BoundaryValue,
  field: string,
  parse: (item: BoundaryValue) => T | null,
): readonly T[] | null {
  if (!isJsonObject(raw)) return null;
  const items = raw[field];
  if (!Array.isArray(items)) return null;
  return items.flatMap((item) => {
    const parsed = parse(item);
    return parsed === null ? [] : [parsed];
  });
}

export function parseDevices(
  raw: BoundaryValue,
): readonly TailnetDevice[] | null {
  return listOf(raw, "devices", parseDevice);
}

export function parseKey(raw: BoundaryValue): TailnetKey | null {
  if (!isJsonObject(raw)) return null;
  const id = idOf(raw);
  if (!id) return null;
  return {
    id,
    description: text(raw.description),
    created: when(raw.created),
    expires: when(raw.expires),
    revoked: when(raw.revoked),
    invalid: flag(raw.invalid),
    reusable: flag(raw.reusable),
    ephemeral: flag(raw.ephemeral),
    preauthorized: flag(raw.preauthorized),
    tags: strings(raw.tags),
  };
}

export function parseKeys(raw: BoundaryValue): readonly TailnetKey[] | null {
  return listOf(raw, "keys", parseKey);
}

export function parseCreatedKey(raw: BoundaryValue): CreatedTailnetKey | null {
  const view = parseKey(raw);
  if (!view || !isJsonObject(raw) || !isString(raw.key)) return null;
  if (!raw.key.startsWith("tskey-auth-") || raw.key.length > 255) return null;
  return { ...view, key: raw.key };
}

export function parseStatus(raw: BoundaryValue): TailnetStatus | null {
  if (!isJsonObject(raw) || !isTailnetRole(raw.role)) return null;
  const credential =
    raw.credential === "oauth" || raw.credential === "api_key"
      ? raw.credential
      : null;
  return {
    connected: flag(raw.connected),
    tailnet: text(raw.tailnet),
    credential,
    role: raw.role,
    label: text(raw.label),
  };
}

function parseAuditEntry(raw: BoundaryValue): TailnetAuditEntry | null {
  if (!isJsonObject(raw) || !isNumber(raw.at) || !isNumber(raw.status))
    return null;
  return {
    at: raw.at,
    pairing: text(raw.pairing),
    label: text(raw.label),
    origin: text(raw.origin),
    action: text(raw.action),
    target: text(raw.target),
    status: raw.status,
  };
}

export function parseAudit(
  raw: BoundaryValue,
): readonly TailnetAuditEntry[] | null {
  return listOf(raw, "entries", parseAuditEntry);
}

export function parseRoutes(raw: BoundaryValue): TailnetRoutes | null {
  if (!isJsonObject(raw)) return null;
  return {
    advertisedRoutes: strings(raw.advertised_routes),
    enabledRoutes: strings(raw.enabled_routes),
  };
}
