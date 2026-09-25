/**
 * The device route's address (ADR 0140 plan step 7): `/device?user_code=`,
 * and the older link shapes that now open it (`legacy` in
 * `spec/config/ceremony-routes.json`), read once and taken out of the
 * address before anything renders.
 *
 * A user code is a display artifact, not a bearer, so a query may carry it;
 * it still leaves the address once read, because nothing on the page needs
 * it there and a reload should not re-offer an approval the person already
 * answered. The reading is ceremony-kit's (`readInteractionArrival`, the one
 * mobile-MFA made): the canonical form and the legacy ones share one parser,
 * one alphabet and one refusal for credential material.
 *
 * What this module adds is *where* a legacy code may be read. The spec's
 * `https` shape names no path, and on this origin the base itself is the
 * sign-in callback: its `?code=` is an OAuth authorization code, never a
 * user code. So on http(s) a code is read only on the device route, and on
 * the base only as `?user_code=` with no `code` or `error` beside it. The
 * custom schemes (`opensesame://invoke/mfa`, `opensesame-mfa://approve`)
 * are read as the spec names them, for a shell that opens this page on one.
 */

import {
  LEGACY_LINKS,
  ceremonyPath,
  parseLegacyInteractionLink,
  readInteractionArrival,
} from "@opensesame/ceremony-kit";
import { env } from "../host.js";
import { maybePage } from "../ports.js";

export type DeviceArrival =
  /** Not the device route, or the route opened with no code. */
  | { kind: "none" }
  /** A user code to confirm and approve. */
  | { kind: "code"; userCode: string }
  /** The link carried credential material, or a code that cannot be one. */
  | { kind: "refused" };

/** What arrived, and the address to put in its place (`null`: leave it). */
export type DeviceLinkRead = {
  arrival: DeviceArrival;
  address: string | null;
};

const NOT_OURS: DeviceLinkRead = { arrival: { kind: "none" }, address: null };

/** `/OpenSesame/device` under base `/OpenSesame/`; `/device` under `/`. */
export function devicePath(base: string): string {
  return `${base.replace(/\/+$/, "")}${ceremonyPath("device")}`;
}

/** `pathname` relative to the deployment base, or `null` outside it. */
export function underBase(pathname: string, base: string): string | null {
  const prefix = base.replace(/\/+$/, "");
  if (
    prefix !== "" &&
    pathname !== prefix &&
    !pathname.startsWith(`${prefix}/`)
  )
    return null;
  const rest = pathname.slice(prefix.length).replace(/\/+$/, "");
  return rest === "" ? "/" : rest;
}

function parse(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** Whether any name a legacy link carried its code under is present. */
function namesACode(params: URLSearchParams): boolean {
  return LEGACY_LINKS.query.some((name) => params.has(name));
}

/**
 * The http(s) addresses a code may be read on: the device route (either
 * spelling), and the base with `?user_code=` alone — the ceremonies app's
 * and mobile-MFA's browser fallback. Anything carrying `code` or `error` at
 * the base is the sign-in callback's.
 */
function readsHere(url: URL, base: string): boolean {
  const at = underBase(url.pathname, base);
  if (at === ceremonyPath("device")) return true;
  if (at !== "/") return false;
  const params = url.searchParams;
  if (params.has("code") || params.has("error")) return false;
  return params.has("user_code");
}

function isWeb(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "http:";
}

/**
 * Read an address for the device route: what arrived, and the address to
 * replace it with. Every address this reads is replaced by the bare device
 * route — the code, a claim id beside it, a refused query and any fragment
 * all leave together. An address that is not a device link is `none` and
 * left exactly as it was.
 */
export function readDeviceLink(href: string, base: string): DeviceLinkRead {
  const url = parse(href);
  if (url === null) return NOT_OURS;
  if (isWeb(url) && !readsHere(url, base)) return NOT_OURS;
  const address = devicePath(base);
  const { arrival } = readInteractionArrival(href);
  if (arrival.kind === "legacy") {
    return { arrival: { kind: "code", userCode: arrival.userCode }, address };
  }
  if (arrival.kind === "refused") return { arrival, address };
  // A custom scheme that is not one of the spec's shapes is not ours.
  if (!isWeb(url)) return NOT_OURS;
  // The route itself, holding a code the parser would not take: refused,
  // never carried forward. With no code at all it simply opened.
  if (namesACode(url.searchParams)) {
    return { arrival: { kind: "refused" }, address };
  }
  return {
    arrival: { kind: "none" },
    address: url.search || url.hash ? address : null,
  };
}

/**
 * The code a person typed or pasted. A pasted legacy link yields the code it
 * carries; one carrying credential material yields nothing. Anything else is
 * the code as typed, trimmed and in the device's upper case.
 */
export function userCodeFromEntry(raw: string): string {
  const entry = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) return entry.toUpperCase();
  try {
    return parseLegacyInteractionLink(entry)?.userCode ?? entry.toUpperCase();
  } catch {
    return "";
  }
}

let captured: DeviceArrival = { kind: "none" };

/**
 * Take a device link out of this page's address, before anything renders
 * (boot), or when the route mounts on an address boot did not see. Only an
 * arrival that holds something replaces what is waiting.
 */
export function captureDeviceLinkFromPage(): DeviceArrival {
  const page = maybePage();
  if (!page) return { kind: "none" };
  const read = readDeviceLink(page.location.href, env().BASE_URL || "/");
  if (read.address !== null) page.replaceUrl(read.address);
  if (read.arrival.kind !== "none") captured = read.arrival;
  return read.arrival;
}

/** Look without taking: the route's first render. */
export function peekDeviceArrival(): DeviceArrival {
  return captured;
}

/** Hand the waiting arrival to the device route, and forget it here. */
export function takeDeviceArrival(): DeviceArrival {
  const taken = captured;
  captured = { kind: "none" };
  return taken;
}

export function resetDeviceArrivalForTests(): void {
  captured = { kind: "none" };
}
