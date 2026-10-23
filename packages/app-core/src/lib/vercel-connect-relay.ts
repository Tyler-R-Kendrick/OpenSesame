/**
 * Browser → Connect relay. The relay holds the Vercel token; this page never
 * does. Same base as the OAuth callback (`connectCallbackBase`).
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { connectCallbackBase } from "./connect-callback.js";

export function connectRelayBase(): string {
  return connectCallbackBase().replace(/\/+$/, "");
}

export function connectRelayConfigured(): boolean {
  return connectRelayBase() !== "";
}

export class RelayError extends Error {
  readonly name = "RelayError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function text(value: BoundaryValue | undefined, max = 240): string {
  return isString(value) ? value.trim().slice(0, max) : "";
}

export async function relayFetch(
  path: string,
  init: RequestInit = {},
): Promise<BoundaryValue> {
  const base = connectRelayBase();
  if (!base) {
    throw new RelayError(0, "unconfigured", "Connect relay is not configured.");
  }
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers,
      signal,
      credentials: "omit",
      mode: "cors",
    });
  } catch {
    if (controller.signal.aborted)
      throw new RelayError(0, "timeout", "The Connect relay timed out.");
    throw new RelayError(0, "unreachable", "Couldn't reach the Connect relay.");
  } finally {
    clearTimeout(timer);
  }
  const body: BoundaryValue = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      isJsonObject(body) && isJsonObject(body.error) ? body.error : {};
    throw new RelayError(
      response.status,
      text(error.code, 64) || "unknown_error",
      text(error.message) || "Request failed.",
    );
  }
  return body;
}

export function asObject(value: BoundaryValue): JsonObject {
  return isJsonObject(value) ? value : {};
}
