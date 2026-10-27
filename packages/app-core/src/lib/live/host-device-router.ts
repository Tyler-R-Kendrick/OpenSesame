import type { DeviceBroker } from "./device-broker.js";
import type { DeviceRequest } from "./device-messages.js";
import type { DeviceResetBroker } from "./device-reset-broker.js";
import type { SeatDevices, SeatIdentity } from "./device-types.js";

export function deviceSeatRouter(
  identity: SeatIdentity,
  send: Parameters<DeviceBroker["seat"]>[1],
  devices: DeviceBroker | null,
  resets: DeviceResetBroker | null,
): SeatDevices {
  const connections = devices?.seat(identity, send) ?? null;
  const reset = resets?.seat(identity, send) ?? null;
  return {
    async handle(request: DeviceRequest) {
      if (request.t === "dev.reset" || request.t === "dev.reset.status") {
        if (reset) await reset.handle(request);
        else send({ t: "dev.error", req: request.req, error: "access_denied" });
        return;
      }
      if (connections) await connections.handle(request);
      else send({ t: "dev.error", req: request.req, error: "access_denied" });
    },
    close() {
      connections?.close();
      reset?.close();
    },
  };
}
