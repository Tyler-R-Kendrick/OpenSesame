/**
 * A device using the grant it holds (ADR 0195): the checks every call passes
 * before the owner's tab makes it, and the answer the device is given.
 *
 * Order matters, and nothing here tells a device more than it was given. A
 * connection that is not in the grant, one that was never there and one that
 * has since gone are all `access_denied`; an operation the connection does not
 * list is `unsupported_operation`; and an operation that would read a secret
 * is refused here whatever the port lists, because that kind of operation has
 * no place on this road.
 */

import type { ConnectionPort } from "./connection-port.js";
import { revealsSecret } from "./connection-port.js";
import { runCall } from "./device-call.js";
import type { DeviceErrorCode, DeviceRequest } from "./device-messages.js";
import {
  CALLS_PER_MINUTE,
  type DeviceLog,
  type Grant,
  MAX_IN_FLIGHT,
  type Seat,
} from "./device-types.js";

/** What a call needs of the broker that holds the grant. */
export type UseContext = Readonly<{
  port: () => ConnectionPort | null;
  now: () => number;
  over: () => boolean;
  log: (entry: DeviceLog) => void;
  changed: () => void;
}>;

type Call = Extract<DeviceRequest, { t: "dev.call" }>;

/** Tell the device no, and tell the owner's log what was asked. */
export function refuse(
  context: UseContext,
  seat: Seat,
  request: Call,
  error: DeviceErrorCode,
): void {
  context.log({
    at: context.now(),
    guest: seat.identity.key,
    what: "denied",
    connection: request.connection,
    operation: request.operation,
  });
  seat.send({ t: "dev.error", req: request.req, error });
}

/** Why a call may not run now, or null. */
function barred(
  context: UseContext,
  grant: Grant,
  request: Call,
): DeviceErrorCode | null {
  const held = context
    .port()
    ?.list()
    .find((entry) => entry.id === request.connection);
  if (!held || !grant.connections.has(request.connection))
    return "access_denied";
  if (revealsSecret(request.operation)) return "unsupported_operation";
  if (!held.operations.includes(request.operation))
    return "unsupported_operation";
  const now = context.now();
  grant.recent = grant.recent.filter((at) => now - at < 60_000);
  if (grant.inFlight >= MAX_IN_FLIGHT) return "temporarily_unavailable";
  if (grant.recent.length >= CALLS_PER_MINUTE) return "temporarily_unavailable";
  return null;
}

/** Answer one `dev.call` for a seat whose grant stands. */
export async function answerCall(
  context: UseContext,
  seat: Seat,
  grant: Grant,
  request: Call,
): Promise<void> {
  const port = context.port();
  const why = port ? barred(context, grant, request) : "access_denied";
  if (!port || why)
    return refuse(context, seat, request, why ?? "access_denied");
  grant.recent.push(context.now());
  grant.inFlight += 1;
  try {
    const { connection, operation, input } = request;
    const called = await runCall(
      port,
      { connection, operation, input },
      grant.ended.signal,
    );
    // After the session ended nobody is owed an answer. After the grant did
    // (revoked, lapsed, replaced) the device is told it is over.
    if (context.over()) return;
    if (grant.ended.signal.aborted)
      return seat.send({
        t: "dev.error",
        req: request.req,
        error: "access_denied",
      });
    if (!called.ok) return refuse(context, seat, request, called.error);
    grant.calls += 1;
    context.log({
      at: context.now(),
      guest: seat.identity.key,
      what: "invoke",
      connection,
      operation,
    });
    seat.send({ t: "dev.result", req: request.req, ...called.shaped });
    context.changed();
  } finally {
    grant.inFlight -= 1;
  }
}
