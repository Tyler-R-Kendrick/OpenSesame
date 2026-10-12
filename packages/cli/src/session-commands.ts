/**
 * `opensesame-id session <link> list|invoke` (ADR 0195): a terminal joins a
 * live session as a device over the owner's NATS relay, runs the device
 * authorization grant (RFC 8628) against the owner's tab, and — once the
 * owner has compared the code on their own screen and picked connections —
 * lists them or uses one through the owner's tab. The terminal never sees a
 * credential: the tab makes the call and answers with labels and links.
 *
 * The link, the invite code and the device code are never printed. The
 * user code is, on stderr, because a person is meant to compare it.
 */

import { hostname } from "node:os";
import {
  type DeviceClient,
  type DeviceCodeView,
  DeviceError,
} from "@opensesame/app-core/lib/live/device-client.js";
import {
  type DeviceSession,
  joinAsDevice,
  linkRelays,
} from "@opensesame/app-core/lib/live/device-session.js";
import {
  type LiveLink,
  parseLiveLink,
} from "@opensesame/app-core/lib/live/link.js";
import { NAME_MAX, cleanText } from "@opensesame/app-core/lib/live/messages.js";
import type { CarrierFactory } from "@opensesame/app-core/lib/live/rendezvous.js";
import { overlapCast } from "@opensesame/os-domain";
import { natsNodeCarriers } from "./live-nats.js";
import {
  SessionRefusal,
  type Stage,
  type StopReason,
  explain,
} from "./session-errors.js";
import {
  printConnections,
  printFailure,
  printResult,
  tell,
} from "./session-output.js";
import type { SessionCommand } from "./session-parse.js";

export interface SessionDependencies {
  /**
   * The carriers a link names, opened from this terminal. A test injects a
   * fake relay; production opens NATS over WebSocket. A factory with a
   * `settled` member is waited on before the command returns.
   */
  sessionCarriers?: SessionCarriers;
}

/** Where in the flow the command is, for saying what a failure meant. */
type Progress = { stage: Stage; invite: boolean };

type SessionCarriers = CarrierFactory & { settled?: () => Promise<void> };

/** What the owner is shown: the label, in one line within the name limit. */
function deviceNameFor(given: string | null): string {
  const label = cleanText(given ?? `opensesame-id on ${hostname()}`);
  return [...label].slice(0, NAME_MAX).join("").trim();
}

/**
 * The carriers, noting whether the NATS relay was ever reached: a join that
 * times out says "the relay is down" rather than "no one answered" when every
 * connection to it failed.
 */
function watched(carriers: SessionCarriers) {
  const tally = { tried: 0, failed: 0 };
  const open: CarrierFactory = async (spec, topic, role) => {
    const counted = spec.kind === "nats";
    if (counted) tally.tried += 1;
    try {
      return await carriers(spec, topic, role);
    } catch (error) {
      if (counted) tally.failed += 1;
      throw error;
    }
  };
  return {
    open,
    down: () => tally.tried > 0 && tally.failed === tally.tried,
  };
}

/** The label the owner is asked about; a session needs one to seat a device. */
function readName(command: SessionCommand): string {
  const name = deviceNameFor(command.deviceName);
  if (name === "")
    throw new SessionRefusal(
      "bad_name",
      "The device needs a name the host can show: pass --name LABEL.",
    );
  return name;
}

/** The link, read and checked before anything is contacted. */
function readLink(command: SessionCommand): LiveLink {
  const link = parseLiveLink(command.link);
  if (link === null)
    throw new SessionRefusal(
      "bad_link",
      "That is not a live-session link (https://…#live=v1… or the v1.… value).",
    );
  if (linkRelays(link) !== true)
    throw new SessionRefusal(
      "no_relay",
      "This session names no NATS relay; a terminal can only join over one.",
    );
  if (link.admission === "invite" && command.code === null)
    throw new SessionRefusal(
      "code_required",
      "This is an invite session: pass the invite code with --code or OPENSESAME_LIVE_CODE.",
    );
  return link;
}

/** Say what to compare, once the host has made its code. */
function announce(view: DeviceCodeView): void {
  tell(
    `Approve it in the host's Live session panel (Devices). Check that the code matches: ${view.userCode}`,
  );
  const minutes = Math.max(1, Math.round(view.expiresIn / 60));
  tell(`Waiting for the host; the request lapses in ${minutes} min.`);
}

/** `promise`, or an aborted ask the moment `signal` fires. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new DeviceError("aborted"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    promise
      .finally(() => signal.removeEventListener("abort", stop))
      .then(resolve, reject);
  });
}

/** Ask for authority, then do what the command is for with the grant. */
async function work(
  command: SessionCommand,
  client: DeviceClient,
  signal: AbortSignal,
  at: Progress,
): Promise<void> {
  at.stage = "authorize";
  const granted = await client.authorize({
    want: command.want,
    onCode: announce,
    signal,
  });
  at.stage = "use";
  if (command.action === "list") {
    printConnections(command.flags, granted.connections, granted.expiresAt);
    return;
  }
  const { connection, operation, input } = command;
  if (!granted.connections.some((entry) => entry.id === connection))
    throw new DeviceError("access_denied");
  const result = await until(client.call(connection, operation, input), signal);
  printResult(command.flags, { connection, operation }, result);
}

export async function runSession(
  command: SessionCommand,
  deps?: SessionDependencies,
): Promise<number> {
  const carriers = deps?.sessionCarriers ?? natsNodeCarriers();
  const relay = watched(carriers);
  const controller = new AbortController();
  let reason: StopReason;
  const stop = (why: "timeout" | "interrupt") => () => {
    reason = why;
    controller.abort();
  };
  const timer = setTimeout(stop("timeout"), command.timeoutSeconds * 1000);
  const onInterrupt = stop("interrupt");
  process.once("SIGINT", onInterrupt);
  const at: Progress = { stage: "join", invite: false };
  let session: DeviceSession | undefined;
  try {
    const link = readLink(command);
    at.invite = link.admission === "invite";
    session = await joinAsDevice({
      link,
      code: command.code,
      name: readName(command),
      carriers: relay.open,
      signal: controller.signal,
      onStatus: (status) =>
        tell(
          status === "asking"
            ? "Asking the host to let this device in…"
            : "Connecting to the host…",
        ),
    });
    await work(command, session.client, controller.signal, at);
    return 0;
  } catch (error) {
    printFailure(
      command.flags,
      explain(overlapCast(error), {
        stage: at.stage,
        stopped: reason,
        seconds: command.timeoutSeconds,
        relayDown: relay.down(),
        invite: at.invite,
      }),
    );
    return 1;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onInterrupt);
    await session?.leave();
    await carriers.settled?.();
  }
}
