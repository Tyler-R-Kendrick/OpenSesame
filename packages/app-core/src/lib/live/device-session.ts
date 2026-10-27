/**
 * Joining a live session as a device (ADR 0196): what a terminal does, stated
 * without any shell.
 *
 * A device has no WebRTC and no vault. It reads the link, opens the carriers
 * the link names, asks the owner to let it in over the owner's NATS server
 * alone (a relay route, ADR 0167), and — once it is in — hands back the
 * client that asks for authority. Nothing here touches the page's stores or
 * plan; the shell supplies the carrier clients, as it does for a browser.
 *
 * A link that names no relay is refused before anything is contacted: a
 * device would have no way to meet the owner, and saying so now is kinder
 * than waiting for a timeout.
 */

import { normalizeInviteCode } from "../join/invite.js";
import { DeviceClient, devicePipe } from "./device-client.js";
import { LiveGuest } from "./guest.js";
import type { LiveLink } from "./link.js";
import { sessionOver } from "./nats-route.js";
import type { CarrierFactory } from "./rendezvous.js";
import { linkRoutes } from "./routes.js";
import { guestCarriersFor, openCarriers } from "./session-carriers.js";

/** Why a device could not get into the session. */
export type DeviceJoinFailure =
  | "bad_link"
  | "bad_code"
  | "no_relay"
  | "no_carrier"
  | "unreachable"
  | "ended"
  | "aborted";

export class DeviceJoinError extends Error {
  constructor(readonly code: DeviceJoinFailure) {
    super(code);
    this.name = "DeviceJoinError";
  }
}

export type DeviceJoinInput = Readonly<{
  link: LiveLink;
  /** The out-of-band code, in an invite session. */
  code: string | null;
  /** What the owner is shown when asked to let this device in. */
  name: string;
  /** The shell's carrier clients. */
  carriers: CarrierFactory;
  /** Stop waiting: leaves the session. */
  signal?: AbortSignal;
  /** How long one request waits for its answer. */
  replyMs?: number;
  /** Told as the request moves: sent, then connecting. */
  onStatus?: (status: "asking" | "connecting") => void;
}>;

export type DeviceSession = Readonly<{
  client: DeviceClient;
  guest: LiveGuest;
  /**
   * Leave the session: the owner's tab drops this seat and its grant.
   * Resolves once the goodbye is on the relay, which is when the carriers
   * may be closed — and they are.
   */
  leave: () => Promise<void>;
}>;

/** Whether the link names a carrier that can carry a session. */
export function linkRelays(link: LiveLink): boolean | null {
  const routes = linkRoutes(link);
  if (routes === null) return null;
  return routes.carriers.some((carrier) => sessionOver(carrier) !== "off");
}

function failureOf(status: LiveGuest["status"]): DeviceJoinFailure | null {
  if (status.at === "joined") return null;
  if (status.at === "unreachable" || status.at === "connect_timeout")
    return "unreachable";
  return status.at === "ended" ? "ended" : null;
}

/** Resolve when the guest is in the session; reject if it never will be. */
function inSession(
  guest: LiveGuest,
  signal: AbortSignal | undefined,
  onStatus: DeviceJoinInput["onStatus"],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // `subscribe` answers at once, before it returns `stop`.
    let stop: (() => void) | null = null;
    const settle = (): void => {
      stop?.();
      stop = null;
    };
    stop = guest.subscribe((status) => {
      if (status.at === "request") onStatus?.("asking");
      if (status.at === "connecting") onStatus?.("connecting");
      const failure = failureOf(status);
      if (status.at === "joined") {
        settle();
        resolve();
      } else if (failure) {
        settle();
        reject(new DeviceJoinError(failure));
      }
    });
    signal?.addEventListener("abort", () => {
      settle();
      reject(new DeviceJoinError("aborted"));
    });
  });
}

/** The invite code as the owner spells it; a malformed one never leaves. */
function spelled(link: LiveLink, code: string | null): string | null {
  if (code === null || link.admission !== "invite") return code;
  const owners = normalizeInviteCode(code);
  if (owners === null) throw new DeviceJoinError("bad_code");
  return owners;
}

/** Join as a device and wait until the owner has let it in. */
export async function joinAsDevice(
  input: DeviceJoinInput,
): Promise<DeviceSession> {
  const { link, name, signal } = input;
  const routes = linkRoutes(link);
  if (routes === null) throw new DeviceJoinError("bad_link");
  if (!linkRelays(link)) throw new DeviceJoinError("no_relay");
  // The code is the pairing's salt, and the owner counts every mismatch as a
  // miss: it leaves in the owner's spelling, or not at all.
  const code = spelled(link, input.code);
  let guest: LiveGuest | null = null;
  const rendezvous = openCarriers(
    routes.carriers,
    link.secret,
    input.carriers,
    (reply) => void guest?.accept(reply),
  );
  if (!rendezvous) throw new DeviceJoinError("no_carrier");
  guest = new LiveGuest({
    link,
    code,
    name,
    note: "",
    transport: null,
    kind: "device",
    route: "relay",
    carriers: guestCarriersFor(rendezvous),
  });
  const joined = inSession(guest, signal, input.onStatus);
  // It may settle while the request is still being made; `await joined` below
  // is the one place that reads it.
  joined.catch(() => undefined);
  try {
    await guest.start();
    await joined;
  } catch (error) {
    guest.leave();
    rendezvous.close();
    if (error instanceof DeviceJoinError) throw error;
    throw new DeviceJoinError("unreachable");
  }
  const client = new DeviceClient(devicePipe(guest), {
    replyMs: input.replyMs,
  });
  return {
    client,
    guest,
    leave: async () => {
      client.close();
      guest.leave();
      await guest.left();
      rendezvous.close();
    },
  };
}
