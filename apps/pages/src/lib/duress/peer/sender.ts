/**
 * Browser sender for optional local HTTPS duress peer receiver (PEER-C).
 * Bound paths only — no generic webhooks / open URL fetch (INV-26).
 */

import {
  type JsonObject,
  includesStringLiteral,
  isJsonObject,
  overlapCast,
} from "../json-boundary.js";
import { PEER_BOUNDS } from "./bounds.js";
import type { PeerEnvelope, PeerReceipt } from "./envelope.js";
import {
  assertBoundedPeerPath,
  assertSafePeerOrigin,
  originsExactMatch,
} from "./origin.js";

export type PeerSenderConfig = Readonly<{
  registeredOrigin: string;
  audience: string;
  signal?: AbortSignal;
}>;

export type PeerSendResult =
  | { ok: true; receipt: PeerReceipt }
  | { ok: false; code: string; httpStatus?: number };

const ALLOWED_PATHS = [
  "/v1/duress/peer/envelope",
  "/v1/duress/peer/receipt",
  "/v1/duress/peer/health",
] as const;

function assertAllowedPath(path: string): string {
  const p = assertBoundedPeerPath(path);
  if (!includesStringLiteral(ALLOWED_PATHS, p)) {
    throw new Error("unapproved_route");
  }
  return p;
}

export async function sendPeerEnvelope(
  envelope: PeerEnvelope,
  config: PeerSenderConfig,
): Promise<PeerSendResult> {
  const originUrl = assertSafePeerOrigin(config.registeredOrigin);
  if (!originsExactMatch(config.registeredOrigin, originUrl.origin)) {
    return { ok: false, code: "unapproved_route" };
  }
  if (envelope.audience !== config.audience) {
    return { ok: false, code: "scope_mismatch" };
  }
  const path = assertAllowedPath("/v1/duress/peer/envelope");
  const body = JSON.stringify(envelope);
  if (body.length > PEER_BOUNDS.httpBodyMaxBytes) {
    return { ok: false, code: "unsupported_factor" };
  }
  try {
    const res = await fetch(`${originUrl.origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-opensesame-duress-peer": "1",
      },
      body,
      signal: config.signal,
      redirect: "error",
      credentials: "omit",
      mode: "cors",
      cache: "no-store",
    });
    if (res.status === 413) {
      return { ok: false, code: "unsupported_factor", httpStatus: 413 };
    }
    const text = await res.text();
    if (text.length > PEER_BOUNDS.httpBodyMaxBytes) {
      return { ok: false, code: "unsupported_factor", httpStatus: res.status };
    }
    if (!res.ok) {
      return {
        ok: false,
        code: "unavailable_authority",
        httpStatus: res.status,
      };
    }
    const wire = JSON.parse(text);
    if (!isJsonObject(wire)) {
      return { ok: false, code: "unsupported_factor", httpStatus: res.status };
    }
    const receipt = overlapCast<JsonObject, PeerReceipt>(wire);
    return { ok: true, receipt };
  } catch {
    return { ok: false, code: "completion_unknown" };
  }
}

export async function probePeerReceiver(
  config: PeerSenderConfig,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const originUrl = assertSafePeerOrigin(config.registeredOrigin);
  const path = assertAllowedPath("/v1/duress/peer/health");
  try {
    const res = await fetch(`${originUrl.origin}${path}`, {
      method: "GET",
      headers: { accept: "application/json", "x-opensesame-duress-peer": "1" },
      signal: config.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, code: "unavailable_authority" };
    return { ok: true };
  } catch {
    return { ok: false, code: "completion_unknown" };
  }
}
