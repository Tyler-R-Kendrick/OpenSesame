/**
 * Exact-match peer identity selectors: SPIFFE ID, DNS reference identity,
 * non-SPIFFE URI SAN, leaf thumbprint. No wildcards, no CN, no email, no IP.
 * Mirrors `PeerIdentitySelector` validation in the Rust plane rule for rule.
 */

import { type JsonValue, isString } from "../json.js";
import {
  MAX_SELECTOR_BYTES,
  decodeTagged,
  fail,
  isValidThumbprint,
  succeed,
} from "./codec.js";
import {
  type PeerIdentitySelector,
  SELECTOR_KINDS,
  type SelectorKind,
  type TransportResult,
} from "./types.js";

const MAX_DNS_BYTES = 253;
const MAX_LABEL_BYTES = 63;
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

function spiffeIdFault(id: string): string | null {
  if (id.length > MAX_SELECTOR_BYTES) return "exceeds 2048 bytes";
  if (!PRINTABLE_ASCII.test(id)) return "must be printable ASCII";
  if (!id.startsWith("spiffe://")) return "must start with spiffe://";
  const rest = id.slice("spiffe://".length);
  const slash = rest.indexOf("/");
  const trustDomain = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash + 1);
  if (!/^[a-z0-9._-]+$/.test(trustDomain))
    return "trust domain must be [a-z0-9._-]+";
  if (path === "") return "workload path is required";
  const segmentOk = (segment: string) =>
    /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..";
  return path.split("/").every(segmentOk)
    ? null
    : "path segments must be non-empty [a-zA-Z0-9._-]+";
}

function dnsNameFault(name: string): string | null {
  if (name.length === 0 || name.length > MAX_DNS_BYTES)
    return "must be 1..=253 bytes";
  if (name.includes("*")) return "wildcards are not selectors";
  if (name.endsWith(".")) return "trailing dot is not a reference identity";
  if (name.includes(":") || /^[0-9.]+$/.test(name))
    return "IP addresses are not selectors";
  const labelOk = (label: string) =>
    label.length >= 1 &&
    label.length <= MAX_LABEL_BYTES &&
    /^[a-z0-9-]+$/.test(label) &&
    !label.startsWith("-") &&
    !label.endsWith("-");
  return name.split(".").every(labelOk)
    ? null
    : "labels must be lowercase LDH, 1..=63 bytes";
}

function uriSanFault(uri: string): string | null {
  if (uri.length === 0 || uri.length > MAX_SELECTOR_BYTES)
    return "must be 1..=2048 bytes";
  if (!PRINTABLE_ASCII.test(uri)) return "must be printable ASCII";
  const colon = uri.indexOf(":");
  const scheme = colon === -1 ? "" : uri.slice(0, colon);
  const rest = colon === -1 ? "" : uri.slice(colon + 1);
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || rest === "") {
    return "scheme must be lowercase [a-z][a-z0-9+.-]* with a body";
  }
  if (scheme === "spiffe") return "SPIFFE IDs use the spiffe_id selector";
  if (scheme === "mailto" || rest.includes("@"))
    return "email addresses are not selectors";
  if (uri.includes("*") || uri.includes("#"))
    return "wildcards and fragments are not selectors";
  return null;
}

function selectorFault(kind: SelectorKind, value: string): string | null {
  switch (kind) {
    case "spiffe_id":
      return spiffeIdFault(value);
    case "dns_name":
      return dnsNameFault(value);
    case "uri_san":
      return uriSanFault(value);
    default:
      return isValidThumbprint(value)
        ? null
        : "thumbprint must be 64 lowercase hex characters";
  }
}

/** The selector's `[kind, value]` pair. */
export function selectorEntry(
  selector: PeerIdentitySelector,
): [SelectorKind, string] {
  if ("spiffe_id" in selector) return ["spiffe_id", selector.spiffe_id];
  if ("dns_name" in selector) return ["dns_name", selector.dns_name];
  if ("uri_san" in selector) return ["uri_san", selector.uri_san];
  return ["leaf_thumbprint_sha256", selector.leaf_thumbprint_sha256];
}

export function selectorsEqual(
  a: PeerIdentitySelector,
  b: PeerIdentitySelector,
): boolean {
  const [kindA, valueA] = selectorEntry(a);
  const [kindB, valueB] = selectorEntry(b);
  return kindA === kindB && valueA === valueB;
}

export function decodeSelector(
  field: string,
  value: JsonValue | undefined,
): TransportResult<PeerIdentitySelector> {
  const tagged = decodeTagged(field, value, [], SELECTOR_KINDS);
  if (!tagged.ok) return tagged;
  const kind = SELECTOR_KINDS.find(
    (candidate) => candidate === tagged.value.tag,
  );
  const raw = tagged.value.payload;
  if (kind === undefined || !isString(raw))
    return fail(`${field}: selector value must be a string`);
  const fault = selectorFault(kind, raw);
  if (fault !== null) return fail(`${field}.${kind}: ${fault}`);
  return succeed(selectorOf(kind, raw));
}

function selectorOf(kind: SelectorKind, value: string): PeerIdentitySelector {
  switch (kind) {
    case "spiffe_id":
      return { spiffe_id: value };
    case "dns_name":
      return { dns_name: value };
    case "uri_san":
      return { uri_san: value };
    default:
      return { leaf_thumbprint_sha256: value };
  }
}
