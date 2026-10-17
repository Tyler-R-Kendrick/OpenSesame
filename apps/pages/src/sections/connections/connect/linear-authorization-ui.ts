import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import type { LinearAuthorizationReservation } from "@opensesame/app-core/lib/linear-auth-reservation.js";
import { readSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import {
  authorizationAttempt,
  authorizationCorrelation,
} from "./native-authorization-ticket.js";
import type { NativeAuthorizationSink } from "./native-connector-controller.js";

function linearRecordKind(id: string) {
  const row = readDeviceRows().find((entry) => entry.connectionId === id);
  if (!row) return "absent";
  return row.providerId === "linear" && readSelfHostedConnector(id)
    ? "same-provider"
    : "other-provider";
}

export function linearAuthorization(
  id: string | undefined,
  sink?: NativeAuthorizationSink,
) {
  const correlation = authorizationCorrelation({
    initial: id && linearRecordKind(id) === "same-provider" ? id : undefined,
    stale: id,
    existing: new Set(readDeviceRows().map((row) => row.connectionId)),
    read: linearRecordKind,
  });
  let attempt: ReturnType<typeof authorizationAttempt> | undefined;
  let stop: (() => void) | undefined;
  return {
    reserve(reservation: LinearAuthorizationReservation) {
      const current = authorizationAttempt(
        reservation.release,
        undefined,
        reservation.assertCurrent,
        () => {
          const retire = stop;
          stop = undefined;
          retire?.();
        },
        correlation,
      );
      attempt = current;
      try {
        stop = sink?.(
          Object.freeze({
            method: "oauth",
            cancel: current.cancel,
            current: current.current,
            selectConnection: current.selectConnection,
          }),
        );
        current.check();
        return current.check;
      } catch (error) {
        current.finish();
        throw error;
      }
    },
    bind: (next: string) => attempt?.bind(next),
    finish: () => attempt?.finish(),
  };
}
