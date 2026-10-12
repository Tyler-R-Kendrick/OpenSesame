import { vi } from "vitest";
import type { ConnectionPort, SessionConnection } from "./connection-port.js";
/**
 * Shared fixtures for the device broker's tests (ADR 0196): a fake port of
 * connections, a broker over it, and a seat whose replies are collected.
 */
import { approveAs } from "./device-approval.test-support.js";
import { DeviceBroker } from "./device-broker.js";
import type { DeviceReply } from "./device-messages.js";
import type { DeviceLog } from "./device-types.js";
import { FAKE_CLOCK } from "./live-clock.fixture.js";

export const GITHUB: SessionConnection = {
  id: "c-github",
  label: "GitHub",
  provider: "github",
  operations: ["provider.read", "provider.repositories.read"],
};
export const VAULT: SessionConnection = {
  id: "c-vault",
  label: "Vault",
  provider: "vault",
  operations: ["provider.read", "provider.secret.read"],
};
export const LINEAR: SessionConnection = {
  id: "c-linear",
  label: "Linear",
  provider: "linear",
  operations: ["provider.read"],
};

export const SESSION_MS = 4 * 60 * 60 * 1000;
export const START = 1_800_000_000_000;

export type Held = {
  connections: SessionConnection[];
  port: ConnectionPort | null;
};

export function setup(
  invoke: ConnectionPort["invoke"] = async () => ({
    label: "Repositories",
    items: [{ id: "r1", label: "opensesame" }],
  }),
  connections: SessionConnection[] = [GITHUB, VAULT, LINEAR],
) {
  const held: Held = { connections, port: null };
  held.port = { list: () => held.connections, invoke };
  const log: DeviceLog[] = [];
  const broker = new DeviceBroker({
    port: () => held.port,
    expiresAt: START + SESSION_MS,
    onLog: (entry) => log.push(entry),
  });
  return { broker, held, log };
}

export function seatOf(broker: DeviceBroker, key = "s1", name = "my laptop") {
  const replies: DeviceReply[] = [];
  const seat = broker.seat({ key, name }, (reply) => replies.push(reply));
  return { seat, replies, last: () => replies[replies.length - 1] };
}

export async function begin(
  broker: DeviceBroker,
  seat: ReturnType<typeof seatOf>,
  want: string[] = [],
) {
  await seat.seat.handle({ t: "dev.begin", req: "b1", want });
  const code = seat.replies.find((reply) => reply.t === "dev.code");
  if (code?.t !== "dev.code") throw new Error("no code");
  const pending = broker.state.pending.find((entry) => entry.seat === "s1");
  if (!pending) throw new Error("not pending");
  return { code, pending };
}

export async function granted(
  connections = ["c-github"],
  invoke?: ConnectionPort["invoke"],
) {
  const world = setup(invoke);
  const device = seatOf(world.broker);
  const { pending } = await begin(world.broker, device);
  await approveAs(world.broker, pending.id, { connections, minutes: 60 });
  return { ...world, device };
}

export const call = (
  operation = "provider.repositories.read",
  connection = "c-github",
) =>
  ({
    t: "dev.call",
    req: "k1",
    connection,
    operation,
    input: {},
  }) as const;

/** The clock every broker test runs under. */
export function useBrokerClock(): void {
  vi.useFakeTimers({ ...FAKE_CLOCK, now: START });
}
