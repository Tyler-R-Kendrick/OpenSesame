/**
 * What went wrong in `opensesame-id session`, said plainly (ADR 0195).
 *
 * Every message is written here, from a closed set of codes: nothing a
 * library or the network says is repeated, so a link, an invite code or a
 * device code cannot come out in an error.
 */

import { DeviceError } from "@opensesame/app-core/lib/live/device-client.js";
import { DeviceJoinError } from "@opensesame/app-core/lib/live/device-session.js";
import type { BoundaryValue } from "@opensesame/os-domain";

/** Where in the flow a failure happened. */
export type Stage = "join" | "authorize" | "use";

/** Why the whole command was stopped, when it was. */
export type StopReason = "timeout" | "interrupt" | undefined;

/** A refusal the command makes before, or instead of, asking the host. */
export class SessionRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionRefusal";
  }
}

/** A failure as the command reports it: a stable code and one sentence. */
export type Explained = Readonly<{ code: string; message: string }>;

type Context = Readonly<{
  stage: Stage;
  stopped: StopReason;
  seconds: number;
  /** Every NATS relay the link names refused or failed the connection. */
  relayDown: boolean;
  /** The session wants an invite code, which a wrong one fails silently. */
  invite: boolean;
}>;

const RELAY_DOWN: Explained = {
  code: "unreachable",
  message:
    "Could not reach the session's NATS relay; is it running, and are the link's credentials still valid?",
};

function seconds(count: number): string {
  return `${count} second${count === 1 ? "" : "s"}`;
}

function stopped(context: Context): Explained {
  if (context.stopped === "interrupt")
    return { code: "interrupted", message: "Interrupted." };
  if (context.stage === "join" && context.relayDown) return RELAY_DOWN;
  const waited = `No answer from the host within ${seconds(context.seconds)}`;
  const hint = context.invite
    ? " An invite session also needs the right code."
    : "";
  return context.stage === "join"
    ? {
        code: "timeout",
        message: `${waited}; was the session started to let devices use connections, and with a NATS relay?${hint}`,
      }
    : {
        code: "timeout",
        message: `${waited}; the request was not approved in time.`,
      };
}

function joinFailure(error: DeviceJoinError, context: Context): Explained {
  switch (error.code) {
    case "bad_link":
      return {
        code: "bad_link",
        message:
          "The link's routes cannot be read; ask the host for a new link.",
      };
    case "no_relay":
      return {
        code: "no_relay",
        message:
          "This session names no NATS relay; a terminal can only join over one.",
      };
    case "bad_code":
      return {
        code: "bad_code",
        message:
          "That is not an invite code; it is two groups of four letters or digits, like BCDF-GHJK.",
      };
    case "no_carrier":
      return {
        code: "no_carrier",
        message:
          "None of the link's carriers can be opened from a terminal; only NATS over WebSocket can.",
      };
    case "unreachable":
      return context.relayDown
        ? RELAY_DOWN
        : {
            code: "unreachable",
            message:
              "Could not reach the host through the relay; is the session still running?",
          };
    case "ended":
      return { code: "ended", message: "The host has ended the session." };
    case "aborted":
      return stopped(context);
  }
}

function deviceFailure(error: DeviceError, context: Context): Explained {
  const asking = context.stage === "authorize";
  switch (error.code) {
    case "access_denied":
      return asking
        ? { code: "access_denied", message: "The host declined this device." }
        : {
            code: "access_denied",
            message:
              "The host did not allow that: the connection is not part of the grant, or the grant was revoked.",
          };
    case "expired_token":
      return asking
        ? {
            code: "expired_token",
            message: "The request lapsed before the host answered.",
          }
        : {
            code: "expired_token",
            message:
              "The grant has lapsed; run the command again to ask for a new one.",
          };
    case "invalid_request":
      return {
        code: "invalid_request",
        message:
          "The host did not accept that request; check the connection, the operation and any --input.",
      };
    case "unsupported_operation":
      return {
        code: "unsupported_operation",
        message: "That connection does not support this operation.",
      };
    case "temporarily_unavailable":
      return {
        code: "temporarily_unavailable",
        message:
          "The host or the provider is busy or unavailable right now; try again shortly.",
      };
    case "upstream_error":
      return {
        code: "upstream_error",
        message: "The provider answered with an error.",
      };
    case "too_large":
      return {
        code: "too_large",
        message: "The answer was too large to send back.",
      };
    case "channel_closed":
      return {
        code: "channel_closed",
        message:
          "The session ended, or the connection to the relay was lost, before the host answered.",
      };
    case "timeout":
      return {
        code: "timeout",
        message: "The host did not answer in time.",
      };
    case "aborted":
      return stopped(context);
  }
}

/** Any failure of the flow as a code and a sentence; never a stack. */
export function explain(error: BoundaryValue, context: Context): Explained {
  if (error instanceof SessionRefusal)
    return { code: error.code, message: error.message };
  if (error instanceof DeviceJoinError) return joinFailure(error, context);
  if (error instanceof DeviceError) return deviceFailure(error, context);
  return {
    code: "failed",
    message: "The session failed unexpectedly; run it again.",
  };
}
