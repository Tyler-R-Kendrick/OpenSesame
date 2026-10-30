/**
 * The CDP network boundary: which destinations a driven browser may
 * reach, and the pre-script lockdown for channels the Fetch domain
 * cannot intercept (WebSocket handshakes, WebRTC).
 */

import { z } from "zod";
import type { CdpConnection, CdpJsonValue } from "./cdp-connection.js";

const pausedRequestSchema = z.object({
  requestId: z.string(),
  request: z.object({ url: z.string() }),
});

/**
 * Which requests may leave the browser. Network schemes are limited
 * to approved hostnames; inert local schemes carry no destination.
 */
export function isAllowedCdpRequest(
  value: string,
  allowedDomains: readonly string[],
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol === "data:" ||
    url.protocol === "blob:" ||
    url.protocol === "about:"
  )
    return true;
  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:" &&
    url.protocol !== "wss:" &&
    url.protocol !== "ws:"
  )
    return false;
  return allowedDomains.includes(url.hostname);
}

/**
 * Injected before any page or worker script runs: the Fetch domain
 * does not intercept WebSocket handshakes or WebRTC, so those
 * constructors are bound to the same hostname allowlist (WebRTC has
 * no hostname destination to allowlist and is refused outright).
 */
export function cdpLockdownScript(allowedDomains: readonly string[]): string {
  return `(() => {
    const allowed = new Set(${JSON.stringify([...allowedDomains])});
    const check = (raw) => {
      let url;
      try { url = new URL(String(raw), globalThis.location?.href ?? "https://invalid/"); }
      catch { throw new Error("opensesame: destination blocked"); }
      if (!allowed.has(url.hostname)) throw new Error("opensesame: destination blocked");
    };
    if (globalThis.WebSocket) {
      const Native = globalThis.WebSocket;
      const Patched = function (url, protocols) {
        check(url);
        return protocols === undefined ? new Native(url) : new Native(url, protocols);
      };
      Patched.prototype = Native.prototype;
      Patched.CONNECTING = 0; Patched.OPEN = 1; Patched.CLOSING = 2; Patched.CLOSED = 3;
      globalThis.WebSocket = Patched;
    }
    if (globalThis.EventSource) {
      const NativeES = globalThis.EventSource;
      globalThis.EventSource = function (url, config) { check(url); return new NativeES(url, config); };
    }
    if (globalThis.RTCPeerConnection) {
      globalThis.RTCPeerConnection = function () { throw new Error("opensesame: WebRTC blocked"); };
    }
  })();`;
}

/**
 * Install the request boundary on one target session. Returns
 * false when interception is unavailable there; the caller then
 * leaves that target paused instead of letting it execute.
 */
export async function installCdpSessionBoundary(
  connection: CdpConnection,
  sessionId: string,
  allowedDomains: readonly string[],
): Promise<boolean> {
  connection.on(
    "Fetch.requestPaused",
    (params) => {
      void handlePausedRequest(connection, sessionId, allowedDomains, params);
    },
    sessionId,
  );
  try {
    await connection.call(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
      sessionId,
    );
  } catch {
    return false;
  }
  const lockdown = cdpLockdownScript(allowedDomains);
  try {
    await connection.call(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: lockdown },
      sessionId,
    );
  } catch {
    // Worker targets have no Page domain; while still paused at
    // start, evaluate the lockdown in the worker global instead.
    try {
      await connection.call(
        "Runtime.evaluate",
        { expression: lockdown },
        sessionId,
      );
    } catch {
      return false;
    }
  }
  return true;
}

async function handlePausedRequest(
  connection: CdpConnection,
  sessionId: string,
  allowedDomains: readonly string[],
  params: CdpJsonValue | undefined,
): Promise<void> {
  const parsed = pausedRequestSchema.safeParse(params);
  if (!parsed.success) return;
  const { requestId, request } = parsed.data;
  try {
    if (isAllowedCdpRequest(request.url, allowedDomains))
      await connection.call("Fetch.continueRequest", { requestId }, sessionId);
    else
      await connection.call(
        "Fetch.failRequest",
        { requestId, errorReason: "BlockedByClient" },
        sessionId,
      );
  } catch {
    // The target may already be gone; a paused request dies with it.
  }
}
