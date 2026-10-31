/** Tailscale's API calls behind the connection (ADR 0217): each a bounded request whose answer is read, not repeated. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { NativeApiError } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { keyCall } from "./native-key-http.js";
import type { NativeKeyTarget } from "./native-key-types.js";
import { API_TOKEN, CLIENT_ID, CLIENT_SECRET } from "./native-tailscale-ui.js";

export const API = "https://api.tailscale.com/api/v2";
export const TOKEN = /^tskey-[A-Za-z0-9_-]{8,300}$/;
export const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
export const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const TAG = /^tag:[a-z][a-z0-9-]{0,62}$/;
const MAX_ITEMS = 200;

export async function bearer(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<string> {
  const direct = target.credentials[API_TOKEN];
  if (direct) return direct;
  const body = await keyCall(
    transport,
    "POST",
    `${API}/oauth/token`,
    undefined,
    {
      kind: "form",
      value: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: target.credentials[CLIENT_ID] ?? "",
        client_secret: target.credentials[CLIENT_SECRET] ?? "",
      }),
    },
  );
  const token = body.access_token;
  if (!isString(token) || !/^[A-Za-z0-9._~+/=-]{16,8192}$/.test(token))
    throw new NativeApiError("response");
  return token;
}

export const tailnetOf = (target: NativeKeyTarget) =>
  encodeURIComponent(target.parameters.tailnet || "-");

export async function call(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Parameters<typeof keyCall>[4],
) {
  const token = await bearer(target, transport);
  return keyCall(transport, method, `${API}${path}`, token, body);
}

export function rows(
  body: Record<string, BoundaryValue>,
  field: string,
  secrets: Record<string, string>,
  describe: (row: Record<string, BoundaryValue>) => {
    id: string;
    label: string;
  },
) {
  const list = body[field];
  if (!Array.isArray(list) || list.length > MAX_ITEMS * 5)
    throw new NativeApiError("response");
  return list.slice(0, MAX_ITEMS).map((row) => {
    if (!isJsonObject(row)) throw new NativeApiError("response");
    const found = describe(row);
    return { id: found.id, label: safeProviderText(found.label, secrets) };
  });
}

export const text = (
  value: BoundaryValue | undefined,
  fallback = "",
): string => (isString(value) ? value : fallback);

export async function devices(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
) {
  const body = await call(
    target,
    transport,
    "GET",
    `/tailnet/${tailnetOf(target)}/devices?fields=default`,
  );
  return rows(body, "devices", target.credentials, (row) => {
    const id = text(row.id);
    if (!DEVICE.test(id)) throw new NativeApiError("response");
    const first = Array.isArray(row.addresses)
      ? row.addresses.find(isString)
      : undefined;
    const address = isString(first) ? first : "";
    const name = text(row.hostname) || text(row.name) || id;
    const pending = row.authorized === false ? " · waiting for approval" : "";
    return {
      id,
      label: `${name}${address ? ` · ${address}` : ""}${pending}`,
    };
  });
}

export function deviceId(input: Record<string, string>): string {
  const id = (input.device ?? "").trim();
  if (!DEVICE.test(id)) throw new Error("Enter a device ID from the list");
  return encodeURIComponent(id);
}

export async function authKeys(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
) {
  const body = await call(
    target,
    transport,
    "GET",
    `/tailnet/${tailnetOf(target)}/keys`,
  );
  return rows(body, "keys", target.credentials, (row) => {
    const id = text(row.id);
    if (!DEVICE.test(id)) throw new Error("Unexpected key identifier");
    const note = text(row.description);
    return { id, label: note ? `${id} · ${note}` : id };
  });
}

export async function createAuthKey(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  input: Record<string, string>,
) {
  const tags = (input.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length > 20 || tags.some((tag) => !TAG.test(tag)))
    throw new Error("Enter tags such as tag:server, separated by commas");
  const days = Number((input.expiry_days ?? "").trim() || "1");
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new Error("Choose an expiry of 1 to 90 days");
  const flag = (name: string, fallback: boolean) =>
    (input[name] ?? (fallback ? "yes" : "no")) === "yes";
  const body = await call(
    target,
    transport,
    "POST",
    `/tailnet/${tailnetOf(target)}/keys`,
    {
      kind: "json",
      value: {
        capabilities: {
          devices: {
            create: {
              reusable: flag("reusable", false),
              ephemeral: flag("ephemeral", false),
              preauthorized: true,
              tags,
            },
          },
        },
        expirySeconds: days * 86400,
      },
    },
  );
  const key = body.key;
  const id = text(body.id);
  if (!isString(key) || !TOKEN.test(key) || !DEVICE.test(id))
    throw new NativeApiError("response");
  return { id, key };
}
