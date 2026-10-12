/**
 * A hosted session with devices, over the fake network (ADR 0195): the
 * owner's side started for real, the connections bound as a port, and a
 * device joined over the relay. Shared by the device session walks.
 */
import { afterEach, beforeEach } from "vitest";
import { plainAccount } from "../account.test-support.js";
import { type ConnectionPort, bindConnectionPort } from "./connection-port.js";
import { joinAsDevice } from "./device-session.js";
import type { LiveHost } from "./host.js";
import { settle } from "./live-clock.fixture.js";
import { type FakeBus, FakeNet } from "./live-fakes.js";
import type { NatsSession } from "./nats-route.js";
import { endHosting, leaveLive, liveSeams, startHosting } from "./session.js";
import type { LiveTransport } from "./transport.js";

export const VAULT_SECRET = "correct horse battery staple";
export const github = plainAccount("GitHub", VAULT_SECRET);

export const CONNECTION = {
  id: "c-github",
  label: "GitHub (work)",
  provider: "github",
  operations: ["provider.read", "provider.repositories.read"],
};
export const OTHER = {
  id: "c-linear",
  label: "Linear",
  provider: "linear",
  operations: ["provider.read"],
};

const original = { items: liveSeams.items, onLock: liveSeams.onLock };
let releasePort: (() => void) | null = null;

/** The seams every walk needs, and the clean-up after each. */
export function useDeviceSession(): void {
  beforeEach(() => {
    liveSeams.items = () => [github];
    liveSeams.onLock = () => () => undefined;
  });
  afterEach(() => {
    releasePort?.();
    releasePort = null;
    endHosting();
    leaveLive();
    liveSeams.items = original.items;
    liveSeams.onLock = original.onLock;
  });
}

export function bindPort(invoke?: ConnectionPort["invoke"]): ConnectionPort {
  const port: ConnectionPort = {
    list: () => [CONNECTION, OTHER],
    invoke:
      invoke ??
      (async () => ({
        label: "Repositories",
        items: [
          { id: "acme/api", label: "acme/api", url: "https://x.test/acme/api" },
        ],
      })),
  };
  releasePort = bindConnectionPort(port);
  return port;
}

export function profile(session?: NatsSession): LiveTransport {
  return {
    addresses: [],
    ice: [],
    relay: false,
    carriers: [
      session
        ? { kind: "nats", url: "wss://nats.example.test", session }
        : { kind: "nats", url: "wss://nats.example.test" },
    ],
  };
}

export type Options = {
  admission?: "invite" | "open";
  devices?: boolean;
  routes?: LiveTransport;
};

export async function host(
  bus: FakeBus,
  options: Options = {},
): Promise<LiveHost> {
  const owner = await startHosting({
    title: "Team",
    scope: { kind: "none" },
    policy: "use",
    admission: options.admission ?? "open",
    minutes: 30,
    transport: new FakeNet().transports(),
    routes: options.routes ?? profile(),
    carriers: bus.factory(),
    devices: options.devices ?? true,
  });
  await settle();
  return owner;
}

export async function joinDevice(
  owner: LiveHost,
  bus: FakeBus,
  name = "work laptop",
) {
  const joining = joinAsDevice({
    link: owner.link,
    code: owner.code,
    name,
    carriers: bus.factory(),
  });
  // An invite session waits for the owner to let the device in.
  for (let round = 0; round < 40; round += 1) {
    const asking = owner.state.guests.find((guest) => guest.state === "asking");
    if (asking) await owner.admit(asking.key);
    await settle(5);
  }
  return joining;
}

export async function pendingRequest(owner: LiveHost) {
  for (
    let round = 0;
    round < 60 && owner.state.devices.pending.length === 0;
    round += 1
  )
    await settle(5);
  const [pending] = owner.state.devices.pending;
  if (!pending) throw new Error("the owner was never asked");
  return pending;
}
