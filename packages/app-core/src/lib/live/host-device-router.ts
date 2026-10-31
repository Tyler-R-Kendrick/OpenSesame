import { DeviceBroker } from "./device-broker.js";
import type { DeviceRequest } from "./device-messages.js";
import { DeviceResetBroker } from "./device-reset-broker.js";
import type { DeviceLog, SeatDevices, SeatIdentity } from "./device-types.js";
import type { HostOptions } from "./host-types.js";

export type SessionDeviceBrokers = Readonly<{
  devices: DeviceBroker | null;
  resets: DeviceResetBroker | null;
}>;

export function createSessionDeviceBrokers(
  options: Pick<HostOptions, "devices" | "resets">,
  expiresAt: number,
  now: () => number,
  onLog: (entry: DeviceLog) => void,
  changed: () => void,
): SessionDeviceBrokers {
  const devices = options.devices
    ? new DeviceBroker({ port: options.devices.port, expiresAt, now, onLog })
    : null;
  const resets = options.resets
    ? new DeviceResetBroker({
        items: options.resets.items,
        expiresAt,
        now,
        changed,
      })
    : null;
  devices?.subscribe(changed);
  return { devices, resets };
}

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
