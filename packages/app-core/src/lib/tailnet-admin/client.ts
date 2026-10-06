import { assertNotDecoySession } from "../decoy-session.js";
/**
 * The daemon a person paired this page with for tailnet device management
 * (ADR 0169), as the port the device panel works through.
 *
 * A person runs `opensesame daemon tailnet pair --origin <this page> --role
 * <read|manage>` on the daemon's machine and pastes the code it prints, or
 * opens the link. The page trades the code, once, for a bearer bound to this
 * origin and that role, and seals it in the open vault (`pairing.ts`). The
 * bearer goes in one header, on requests to that address only, through the
 * capability's egress port: a revoked plan, an undeclared destination or a
 * redirect is refused before a socket opens. With nothing paired, a guest,
 * or the vault locked, nothing is sent. The Tailscale credential never comes
 * near this page; the daemon holds it.
 */

import type { CapabilityId } from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { pageOrigin } from "../../ports.js";
import { readBoundedObject } from "../bounded-response.js";
import { TAILNET_DEVICES_PURPOSE } from "../capabilities/catalog-optional-services.js";
import type { EgressPort } from "../capabilities/runtime-contract.js";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { SECRET } from "../tailnet-sync/plugin-pairing.js";
import { TailnetAdminError } from "./errors.js";
import {
  TAILNET_PAIRING_PATH,
  type TailnetAdminPairing,
  type TailnetPairingCode,
  isTailnetRole,
  parseTailnetPairingCode,
} from "./pairing.js";
import {
  bindTailnetPairing,
  currentTailnetPairing,
  dropTailnetPairing,
  keepTailnetPairing,
  subscribeTailnetPairing,
  tailnetPairingPossible,
  tailnetPairingRevision,
} from "./store.js";
import {
  type CreatedTailnetKey,
  type TailnetAuditEntry,
  type TailnetDevice,
  type TailnetKey,
  type TailnetRoutes,
  type TailnetStatus,
  parseAudit,
  parseCreatedKey,
  parseDevice,
  parseDevices,
  parseKeys,
  parseRoutes,
  parseStatus,
} from "./wire.js";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Seams a test replaces: the stored pairing, who says it moved, this page. */
export const tailnetAdminSeams = {
  pairing: currentTailnetPairing,
  revision: tailnetPairingRevision,
  subscribe: subscribeTailnetPairing,
  /** An owner's vault is open: somewhere to seal what pairing returns. */
  vaultReady: tailnetPairingPossible,
  /** This deployment may reach local authority at all (not a shared origin). */
  eligible: (): boolean => localNetworkFetchSeams.eligible(),
  bind: bindTailnetPairing,
  keep: keepTailnetPairing,
  drop: dropTailnetPairing,
  pageOrigin: (): string => pageOrigin(),
};

/** The paired daemon as a panel names it: never the bearer. */
export type TailnetTarget = Readonly<{
  label: string;
  host: string;
  role: TailnetAdminPairing["role"];
  revision: number;
}>;

/** Why this page cannot pair right now; `null` when it can. */
export type PairBlocker = "shared-origin" | "locked";

function pairBlocker(): PairBlocker | null {
  if (!tailnetAdminSeams.eligible()) return "shared-origin";
  return tailnetAdminSeams.vaultReady() ? null : "locked";
}

/** What a page asks for when it adds a device. */
export type KeyRequest = Readonly<{
  description: string;
  reusable: boolean;
  ephemeral: boolean;
  preauthorized: boolean;
  tags: readonly string[];
  expirySeconds: number;
}>;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function readBody(response: Response): Promise<BoundaryValue> {
  if (response.status === 204) return null;
  return readBoundedObject(response, MAX_BYTES, TIMEOUT_MS).catch(() => {
    throw new TailnetAdminError("malformed", response.status);
  });
}

/** A refusal in the daemon's own code, or `malformed` when it gave none. */
function refusal(status: number, body: BoundaryValue): TailnetAdminError {
  if (!isJsonObject(body) || !isString(body.error))
    return new TailnetAdminError("malformed", status);
  const detail = isString(body.detail) ? body.detail.slice(0, 200) : "";
  return new TailnetAdminError(body.error, status, detail);
}

function parsed<T>(value: T | null, status: number): T {
  if (value === null) throw new TailnetAdminError("malformed", status);
  return value;
}

/** Path segments are ids the daemon validates again; never encode a slash in. */
function segment(id: string): string {
  return encodeURIComponent(id);
}

export type TailnetAdmin = ReturnType<typeof tailnetAdmin>;

/** One answer from the daemon: its status, and its body once read. */
type DaemonAnswer = Readonly<{ status: number; body: BoundaryValue }>;

type Transport = ReturnType<typeof transport>;

function transport(egress: EgressPort, capability: CapabilityId) {
  const meta = { capability, purpose: TAILNET_DEVICES_PURPOSE };

  function send(base: string, path: string, init: RequestInit) {
    assertNotDecoySession();
    return egress.fetch(
      `${base}${path}`,
      { ...init, credentials: "omit", cache: "no-store" },
      meta,
    );
  }

  /** One request with the bearer in force when it began. */
  async function call(
    method: string,
    path: string,
    body?: BoundaryValue,
    signal?: AbortSignal,
  ): Promise<DaemonAnswer> {
    const authorityGeneration = assertNotDecoySession();
    const pairing = tailnetAdminSeams.pairing();
    if (!pairing) throw new TailnetAdminError("no-daemon");
    const headers = new Headers({ Authorization: `Bearer ${pairing.token}` });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await send(pairing.url, `/v1/tailnet${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    }).catch(() => {
      throw new TailnetAdminError("unreachable");
    });
    const answer = await readBody(response);
    assertNotDecoySession(authorityGeneration);
    if (!response.ok) throw refusal(response.status, answer);
    return { status: response.status, body: answer };
  }

  async function read<T>(
    path: string,
    parse: (raw: BoundaryValue) => T | null,
    signal?: AbortSignal,
  ): Promise<T> {
    const answer = await call("GET", path, undefined, signal);
    return parsed(parse(answer.body), answer.status);
  }

  return { send, call, read };
}

function currentTarget(): TailnetTarget | null {
  const pairing = tailnetAdminSeams.pairing();
  return pairing
    ? {
        label: pairing.label,
        host: hostOf(pairing.url),
        role: pairing.role,
        revision: tailnetAdminSeams.revision(),
      }
    : null;
}

/** Trade a pasted code, once, for a bearer bound to this origin and role. */
async function pair(
  wire: Transport,
  raw: string,
  signal?: AbortSignal,
): Promise<void> {
  const code = parseTailnetPairingCode(raw);
  if (!code) throw new TailnetAdminError("not-a-code");
  if (code.origin !== tailnetAdminSeams.pageOrigin())
    throw new TailnetAdminError("other-origin");
  const blocked = pairBlocker();
  if (blocked) throw new TailnetAdminError(blocked);
  const replaced = tailnetAdminSeams.pairing();
  const began = tailnetAdminSeams.bind();
  const response = await wire
    .send(code.url, TAILNET_PAIRING_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.code }),
      signal,
    })
    .catch(() => {
      throw new TailnetAdminError("unreachable");
    });
  if (response.status === 403 || response.status === 429)
    throw new TailnetAdminError("pairing-refused", response.status);
  const answer = await readBody(response);
  if (!response.ok) throw refusal(response.status, answer);
  const bearer = bearerFor(code, answer, response.status);
  await tailnetAdminSeams.keep(bearer, began);
  // The bearer this one replaced would stay live on its daemon until an
  // operator unpaired it: revoke it there, best effort.
  if (replaced && replaced.token !== bearer.token)
    await revokeAt(wire, replaced, signal);
}

/** The bearer a daemon answered with, if it is one for this code's origin. */
function bearerFor(
  code: TailnetPairingCode,
  answer: BoundaryValue,
  status: number,
): TailnetAdminPairing {
  if (
    !isJsonObject(answer) ||
    !isString(answer.token) ||
    !SECRET.test(answer.token) ||
    answer.origin !== code.origin ||
    !isTailnetRole(answer.role)
  )
    throw new TailnetAdminError("malformed", status);
  return {
    url: code.url,
    token: answer.token,
    origin: code.origin,
    role: answer.role,
    label: code.label,
  };
}

/** Ask `pairing`'s daemon to drop its bearer; a daemon that is gone is fine. */
async function revokeAt(
  wire: Transport,
  pairing: TailnetAdminPairing,
  signal?: AbortSignal,
): Promise<void> {
  await wire
    .send(pairing.url, TAILNET_PAIRING_PATH, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${pairing.token}` },
      signal,
    })
    .catch(() => null);
}

/** Tell the daemon to drop this page's bearer, then forget it here either way. */
async function forget(wire: Transport, signal?: AbortSignal): Promise<void> {
  const pairing = tailnetAdminSeams.pairing();
  if (!pairing) return;
  const issuedFor = tailnetAdminSeams.revision();
  await revokeAt(wire, pairing, signal);
  await tailnetAdminSeams.drop(issuedFor);
}

function deviceOps({ call, read }: Transport) {
  async function change(id: string, what: string, body?: BoundaryValue) {
    await call("POST", `/devices/${segment(id)}/${what}`, body);
  }
  return {
    listDevices: (signal?: AbortSignal): Promise<readonly TailnetDevice[]> =>
      read("/devices", parseDevices, signal),
    getDevice: (id: string, signal?: AbortSignal): Promise<TailnetDevice> =>
      read(`/devices/${segment(id)}`, parseDevice, signal),
    setAuthorized: (id: string, authorized: boolean) =>
      change(id, "authorized", { authorized }),
    rename: (id: string, name: string) => change(id, "name", { name }),
    setTags: (id: string, tags: readonly string[]) =>
      change(id, "tags", { tags: [...tags] }),
    setKeyExpiryDisabled: (id: string, disabled: boolean) =>
      change(id, "key-expiry", { disabled }),
    expire: (id: string) => change(id, "expire"),
    async setRoutes(
      id: string,
      routes: readonly string[],
    ): Promise<TailnetRoutes> {
      const answer = await call("POST", `/devices/${segment(id)}/routes`, {
        enabled_routes: [...routes],
      });
      return parsed(parseRoutes(answer.body), answer.status);
    },
    async deleteDevice(id: string): Promise<void> {
      await call("DELETE", `/devices/${segment(id)}`);
    },
  };
}

function keyOps({ call, read }: Transport) {
  return {
    listKeys: (signal?: AbortSignal): Promise<readonly TailnetKey[]> =>
      read("/keys", parseKeys, signal),
    async createKey(request: KeyRequest): Promise<CreatedTailnetKey> {
      const answer = await call("POST", "/keys", {
        description: request.description,
        reusable: request.reusable,
        ephemeral: request.ephemeral,
        preauthorized: request.preauthorized,
        tags: [...request.tags],
        expiry_seconds: request.expirySeconds,
      });
      return parsed(parseCreatedKey(answer.body), answer.status);
    },
    async deleteKey(id: string): Promise<void> {
      await call("DELETE", `/keys/${segment(id)}`);
    },
  };
}

export function tailnetAdmin(egress: EgressPort, capability: CapabilityId) {
  const wire = transport(egress, capability);
  return {
    subscribe: (listener: () => void) => tailnetAdminSeams.subscribe(listener),
    canPair: () => pairBlocker() === null,
    pairBlocker,
    target: currentTarget,
    pair: (raw: string, signal?: AbortSignal) => pair(wire, raw, signal),
    forget: (signal?: AbortSignal) => forget(wire, signal),
    status: (signal?: AbortSignal): Promise<TailnetStatus> =>
      wire.read("/status", parseStatus, signal),
    ...deviceOps(wire),
    ...keyOps(wire),
    audit: (signal?: AbortSignal): Promise<readonly TailnetAuditEntry[]> =>
      wire.read("/audit", parseAudit, signal),
  };
}
