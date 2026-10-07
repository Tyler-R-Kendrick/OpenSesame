import {
  type BoundaryValue,
  type JsonObject,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { page, pageOrigin } from "../ports.js";
import type { Connection, ConsentOutcome } from "./connections.js";
function obj(value: BoundaryValue): JsonObject {
  return value && isTypeofObject(value) ? overlapCast(value) : {};
}
const POLL_MS = 1500;
const CONSENT_TIMEOUT_MS = 5 * 60_000;

/**
 * Wait for the consent popup's round trip. Connect bounces the popup back to
 * this app, which tells its opener from its own origin, so that is the one
 * origin a message may come from; the poll settles it when no message does.
 */
export async function awaitConnectionConsent(
  connectionId: string,
  popup: Window | null,
  getConnection: (id: string) => Promise<Connection>,
  signal?: AbortSignal,
): Promise<ConsentOutcome> {
  const origin = pageOrigin();
  const deadline = Date.now() + CONSENT_TIMEOUT_MS;

  let settled = false;
  let sawMessage = false;
  let onMessage: ((event: MessageEvent) => void) | null = null;

  const messaged = new Promise<void>((resolve) => {
    onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const data = obj(event.data);
      if (data.type !== "opensesame:connection") return;
      if (data.connectionId !== connectionId) return;
      sawMessage = true;
      resolve();
    };
    page().addEventListener("message", onMessage);
  });

  try {
    while (!settled) {
      if (signal?.aborted) return { result: "abandoned" };
      if (Date.now() > deadline) return { result: "abandoned" };

      if (sawMessage) {
        await sleep(POLL_MS);
      } else {
        await Promise.race([messaged, sleep(POLL_MS)]);
      }

      const connection = await getConnection(connectionId).catch(() => null);
      if (connection && connection.status !== "pending") {
        settled = true;
        return connection.status === "active"
          ? { result: "active", connection }
          : { result: "failed", connection };
      }

      if (popup?.closed) {
        await sleep(POLL_MS);
        const last = await getConnection(connectionId).catch(() => null);
        if (last && last.status !== "pending") {
          return last.status === "active"
            ? { result: "active", connection: last }
            : { result: "failed", connection: last };
        }
        return { result: "abandoned" };
      }
    }
    return { result: "abandoned" };
  } finally {
    if (onMessage) page().removeEventListener("message", onMessage);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
