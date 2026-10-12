import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * A whole hosted live session in this process, for the `session` command's
 * tests: the real owner (pairing, sealed seat channel, device broker) with only
 * the network faked, and the test playing the person at the owner's tab.
 */
import { configureHost } from "@opensesame/app-core/host.js";
import { plainAccount } from "@opensesame/app-core/lib/account.test-support.js";
import {
  type ConnectionPort,
  bindConnectionPort,
} from "@opensesame/app-core/lib/live/connection-port.js";
import type { LiveHost } from "@opensesame/app-core/lib/live/host.js";
import { formatLiveLink } from "@opensesame/app-core/lib/live/link.js";
import { settle } from "@opensesame/app-core/lib/live/live-clock.fixture.js";
import { FakeBus, FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import type { NatsSession } from "@opensesame/app-core/lib/live/nats-route.js";
import type { CarrierFactory } from "@opensesame/app-core/lib/live/rendezvous.js";
import {
  endHosting,
  leaveLive,
  liveSeams,
  startHosting,
} from "@opensesame/app-core/lib/live/session.js";
import type { LiveTransport } from "@opensesame/app-core/lib/live/transport.js";
import { createNodeHost } from "@opensesame/app-core/node/host.js";
import { afterEach, beforeEach, vi } from "vitest";
import { runCli } from "./run.js";

/** The owner's vault password: it must never appear anywhere a device can. */
export const VAULT_SECRET = "correct horse battery staple";

export const GITHUB = {
  id: "c-github",
  label: "GitHub (work)",
  provider: "github",
  operations: ["provider.read", "provider.repositories.read"],
};
export const LINEAR = {
  id: "c-linear",
  label: "Linear",
  provider: "linear",
  operations: ["provider.read"],
};

const APP = "https://app.example.test/";

type Invoke = ConnectionPort["invoke"];

const original = { items: liveSeams.items, onLock: liveSeams.onLock };

/** What a command printed, and how it ended. */
export type Ran = Readonly<{ code: number; out: string; err: string }>;

export type World = Readonly<{
  /** What has been written so far. */
  output: () => Readonly<{ out: string; err: string }>;
  /** Bind the owner's connections; `invoke` answers what is called. */
  bind: (invoke?: Invoke) => void;
}>;

/** Hooks that give each test a clean owner, port and captured streams. */
export function useSessionWorld(): World {
  let out = "";
  let err = "";
  let release: (() => void) | null = null;
  let stateDir = "";
  beforeEach(async () => {
    out = "";
    err = "";
    // The owner's side runs in this process and needs a host, as a tab has.
    stateDir = await mkdtemp(join(tmpdir(), "opensesame-id-session-"));
    configureHost(createNodeHost({ stateDir }));
    liveSeams.items = () => [plainAccount("GitHub", VAULT_SECRET)];
    liveSeams.onLock = () => () => undefined;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    release?.();
    release = null;
    endHosting();
    leaveLive();
    globalThis.__opensesameAppCoreHost = undefined;
    await rm(stateDir, { recursive: true, force: true });
    liveSeams.items = original.items;
    liveSeams.onLock = original.onLock;
  });
  return {
    output: () => ({ out, err }),
    bind: (invoke) => {
      release?.();
      release = bindConnectionPort({
        list: () => [GITHUB, LINEAR],
        invoke:
          invoke ??
          (async () => ({
            label: "Repositories",
            items: [
              {
                id: "acme/api",
                label: "acme/api",
                url: "https://x.test/acme/api",
              },
            ],
          })),
      });
    },
  };
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

export type HostOptions = {
  admission?: "invite" | "open";
  devices?: boolean;
  routes?: LiveTransport;
};

/** The owner's tab hosting a session over `relay`: a fake bus or real carriers. */
export async function host(
  relay: FakeBus | CarrierFactory,
  options: HostOptions = {},
): Promise<LiveHost> {
  const owner = await startHosting({
    title: "Team",
    scope: { kind: "none" },
    policy: "use",
    admission: options.admission ?? "open",
    minutes: 30,
    transport: new FakeNet().transports(),
    routes: options.routes ?? profile(),
    carriers: relay instanceof FakeBus ? relay.factory() : relay,
    devices: options.devices ?? true,
  });
  await settle();
  return owner;
}

/** The link as the owner copies it from the panel. */
export function linkOf(owner: LiveHost): string {
  return formatLiveLink(APP, owner.link);
}

/**
 * The request the owner is asked about, once it arrives. In an invite session
 * the owner also lets the asking device in, as the panel's Admit key does.
 */
export async function pendingRequest(owner: LiveHost) {
  for (
    let round = 0;
    round < 100 && owner.state.devices.pending.length === 0;
    round += 1
  ) {
    const asking = owner.state.guests.find((guest) => guest.state === "asking");
    if (asking) await owner.admit(asking.key);
    await settle(5);
  }
  const [pending] = owner.state.devices.pending;
  if (!pending) throw new Error("the owner was never asked");
  return pending;
}

/** Run the command with `bus` as the only network it can see. */
export function execute(
  world: World,
  argv: string[],
  carriers: Parameters<typeof runCli>[1] = {},
): Promise<Ran> {
  const before = world.output();
  return runCli(argv, carriers).then((code) => {
    const after = world.output();
    return {
      code,
      out: after.out.slice(before.out.length),
      err: after.err.slice(before.err.length),
    };
  });
}
