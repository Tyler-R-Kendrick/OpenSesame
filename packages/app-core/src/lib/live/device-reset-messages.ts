import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
} from "@opensesame/os-domain";
import { canonicalDigest } from "../capabilities/trust/digest.js";

export const RESET_ACTIONS = [
  "password_reset.domain_metadata.list",
  "password_reset.item.use",
  "password_reset.mailbox.read",
  "password_reset.browser.drive",
  "password_reset.runtime.execute",
  "password_reset.model.plan",
  "password_reset.proxy.substitute",
  "password_reset.password.produce",
  "password_reset.human.takeover",
  "password_reset.run.reconcile",
  "password_reset.run.compensate",
] as const;

export type ResetAction = (typeof RESET_ACTIONS)[number];
export type ResetHumanStatus = "takeover_requested";

export type ResetRequestDetails = Readonly<{
  origin: string;
  item: string;
  runtime: string;
  model: string;
  expiresAt: number;
  actions: readonly ResetAction[];
}>;

export type DeviceResetRequest = ResetRequestDetails &
  Readonly<{ t: "dev.reset"; req: string; digest: string }>;

export type DeviceResetStatus = Readonly<{
  t: "dev.reset.status";
  req: string;
  grant: string;
  status: ResetHumanStatus;
}>;

export type DeviceResetItem = Readonly<{
  id: string;
  name: string;
  origins: readonly string[];
}>;

export type DeviceResetGrant = ResetRequestDetails &
  Readonly<{
    t: "dev.reset.grant";
    req: string;
    grant: string;
    digest: string;
    items?: readonly DeviceResetItem[];
  }>;

export type DeviceResetAck = Readonly<{
  t: "dev.reset.ack";
  req: string;
}>;

export type DeviceResetMessage =
  | DeviceResetRequest
  | DeviceResetStatus
  | DeviceResetGrant
  | DeviceResetAck;

const REQ = /^[A-Za-z0-9_-]{1,32}$/;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const PROVIDER = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUEST_KEYS = [
  "req",
  "origin",
  "item",
  "runtime",
  "model",
  "expiresAt",
  "actions",
  "digest",
];
const STATUS_KEYS = ["req", "grant", "status"];
const GRANT_KEYS = [...REQUEST_KEYS, "grant"];
const ACTION_SET = new Set<string>(RESET_ACTIONS);
const METADATA = "password_reset.domain_metadata.list";

function exact(body: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(body);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function origin(value: BoundaryValue): value is string {
  if (!isString(value) || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function expiry(value: BoundaryValue): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function actions(value: BoundaryValue): readonly ResetAction[] | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const action = value[0];
  // SAFETY: ACTION_SET contains only the RESET_ACTIONS contract values.
  return isString(action) && ACTION_SET.has(action)
    ? [action as ResetAction]
    : null;
}

function resetItems(
  value: BoundaryValue,
): readonly DeviceResetItem[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) return null;
  const items = value.map((entry) => {
    if (!isTypeofObject(entry) || entry === null || Array.isArray(entry))
      return null;
    // SAFETY: the runtime object checks establish a JsonObject boundary.
    const item = entry as JsonObject;
    if (
      !isString(item.id) ||
      !ID.test(item.id) ||
      !isString(item.name) ||
      item.name.length === 0 ||
      item.name.length > 200 ||
      !Array.isArray(item.origins) ||
      item.origins.length > 20 ||
      !item.origins.every(origin) ||
      Object.keys(item).length !== 3
    )
      return null;
    return { id: item.id, name: item.name, origins: item.origins };
  });
  // SAFETY: every item was validated by the parser above.
  return items.every((item) => item !== null)
    ? (items as DeviceResetItem[])
    : null;
}

function details(body: JsonObject): ResetRequestDetails | null {
  const parsedActions = actions(body.actions);
  if (
    !origin(body.origin) ||
    !isString(body.item) ||
    !ID.test(body.item) ||
    !isString(body.runtime) ||
    !PROVIDER.test(body.runtime) ||
    !isString(body.model) ||
    !MODEL.test(body.model) ||
    !expiry(body.expiresAt) ||
    !parsedActions ||
    (parsedActions[0] === METADATA) !== (body.item === "metadata")
  )
    return null;
  return {
    origin: body.origin,
    item: body.item,
    runtime: body.runtime,
    model: body.model,
    expiresAt: body.expiresAt,
    actions: parsedActions,
  };
}

export function resetRequestDigest(
  request: ResetRequestDetails,
): Promise<string> {
  return canonicalDigest({
    origin: request.origin,
    item: request.item,
    runtime: request.runtime,
    model: request.model,
    expiresAt: request.expiresAt,
    actions: [...request.actions],
  });
}

export function readDeviceResetMessage(
  t: string,
  body: JsonObject,
): DeviceResetMessage | null {
  if (!isString(body.req) || !REQ.test(body.req)) return null;
  switch (t) {
    case "dev.reset":
      return readRequest(body, body.req);
    case "dev.reset.status":
      return readStatus(body, body.req);
    case "dev.reset.grant":
      return readGrant(body, body.req);
    case "dev.reset.ack":
      return exact(body, ["req"]) ? { t, req: body.req } : null;
    default:
      return null;
  }
}

function readRequest(body: JsonObject, req: string): DeviceResetRequest | null {
  if (!exact(body, REQUEST_KEYS)) return null;
  const request = details(body);
  return request && isString(body.digest) && DIGEST.test(body.digest)
    ? { t: "dev.reset", req, ...request, digest: body.digest }
    : null;
}

function readStatus(body: JsonObject, req: string): DeviceResetStatus | null {
  if (!exact(body, STATUS_KEYS)) return null;
  return isString(body.grant) &&
    ID.test(body.grant) &&
    body.status === "takeover_requested"
    ? {
        t: "dev.reset.status",
        req,
        grant: body.grant,
        status: body.status,
      }
    : null;
}

function readGrant(body: JsonObject, req: string): DeviceResetGrant | null {
  const keys = body.items === undefined ? GRANT_KEYS : [...GRANT_KEYS, "items"];
  if (!exact(body, keys)) return null;
  const request = details(body);
  const items = resetItems(body.items);
  const metadata = request?.actions[0] === METADATA;
  if (
    !request ||
    items === null ||
    metadata !== (items !== undefined) ||
    !isString(body.grant) ||
    !ID.test(body.grant) ||
    !isString(body.digest) ||
    !DIGEST.test(body.digest)
  )
    return null;
  const reply: DeviceResetGrant = {
    t: "dev.reset.grant",
    req,
    grant: body.grant,
    ...request,
    digest: body.digest,
  };
  return items === undefined ? reply : { ...reply, items };
}
