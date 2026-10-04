/**
 * The `audit` and `requests` families of the device Identity plane (ADR 0160,
 * ADR 0162), as `identity.local-iam` contributes them.
 *
 * - `GET /v1/audit/events?limit=N` answers the receipts this device wrote for
 *   its person (`device-receipts.ts`), newest first.
 * - `GET /v1/authorization-requests` answers the inbox (`device-inbox.ts`):
 *   the closed `{ kind, action, ref, expiresAt }` rows of what waits.
 *
 * Both are the caller's own: a handler is handed the resolved caller and reads
 * the tomb that caller's key lives in, so a guest reads the guest tomb and a
 * member's never. There is no decision route. A request is decided in the
 * Access ceremony with a passkey, and `POST` here is refused rather than
 * implemented, so the plane cannot be talked into settling one.
 *
 * What the host answers before a handler is asked is its own: a locked vault
 * is 423 and never reaches here.
 */

import type { JsonObject } from "@opensesame/os-domain";
import type { DeviceRouteRequest } from "./device-identity-routes.js";
import { listInbox } from "./device-inbox.js";
import { listReceipts, pendingReceipts } from "./device-receipts.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function answer(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * What a caller may read: the tomb its own key lives in. A caller with no live
 * bearer is 401. One whose session was minted with no vault behind it, or whose
 * key could not be read, is bound to no tomb and is 403, never handed whichever
 * vault happens to be open (ADR 0160 §5: an unbound session has no tomb).
 */
function tombOf({ caller }: DeviceRouteRequest): string | Response {
  if (caller === null) return answer({ error: "unauthorized" }, 401);
  if (caller.tomb.length === 0) return answer({ error: "forbidden" }, 403);
  return caller.tomb;
}

function limitOf(path: string): number {
  const raw = new URLSearchParams(path.split("?")[1] ?? "").get("limit");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/** `audit`: the receipts of this device, readable by its own session only. */
export async function auditRoute(
  request: DeviceRouteRequest,
): Promise<Response> {
  if (request.bare !== "/v1/audit/events")
    return answer({ error: "not_found" }, 404);
  if (request.method !== "GET")
    return answer({ error: "method_not_allowed" }, 405);
  const tomb = tombOf(request);
  if (tomb instanceof Response) return tomb;
  const events = await listReceipts(tomb, limitOf(request.path));
  // How many decisions are made and not yet in the trail, so a reader can say
  // the trail is behind rather than let it read as complete.
  return answer({ events, pending: await pendingReceipts(tomb) });
}

/** `requests`: what waits for this person. Read-only; deciding is a ceremony. */
export async function requestsRoute(
  request: DeviceRouteRequest,
): Promise<Response> {
  if (request.bare !== "/v1/authorization-requests")
    // A hosted request is addressed by id. This device holds none of those.
    return answer({ error: "not_found" }, 404);
  if (request.method !== "GET")
    return answer({ error: "method_not_allowed" }, 405);
  const tomb = tombOf(request);
  if (tomb instanceof Response) return tomb;
  return answer({ requests: await listInbox(tomb) });
}
