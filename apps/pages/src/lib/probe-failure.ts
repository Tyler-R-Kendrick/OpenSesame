/**
 * Why a reachability probe failed, to the extent a browser will say.
 *
 * A browser deliberately collapses connection-refused, DNS failure, TLS
 * rejection and CORS denial into one opaque `TypeError`. Guessing between them
 * would put a confident wrong diagnosis in front of an operator, so
 * `unreachable` is the honest bucket for all four. The classes below are only
 * the ones we can actually tell apart — and each one has a different remedy,
 * which is the whole point of separating them.
 */
import { type BoundaryValue, isOnline } from "@opensesame/os-domain";
import { isOnline as readOnline } from "./connectivity.js";

export type ProbeThrownValue = BoundaryValue | DOMException;
export const probeFailureSeams = { isOnline: readOnline };

export type FailureClass =
  /** The browser says there is no network at all. */
  | "offline"
  /** Our own abort timer fired before anything answered. */
  | "timeout"
  /** Something refused, resolved nowhere, or was blocked. Indistinguishable. */
  | "unreachable"
  /** It answered, and said no: 401/403. Credentials, not connectivity. */
  | "rejected"
  /** It answered, and it is broken: 5xx. */
  | "server-error"
  /** Something is listening, but it is not the service we asked for. */
  | "not-opensesame";

export function classifyThrown(error: ProbeThrownValue): FailureClass {
  if (!probeFailureSeams.isOnline()) return "offline";
  if (error instanceof DOMException) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
  }
  if (error instanceof Error && /timed out/i.test(error.message)) {
    return "timeout";
  }
  return "unreachable";
}

/** Classify a response that arrived but was not the answer we wanted. */
export function classifyResponse(status: number): FailureClass {
  if (status === 401 || status === 403) return "rejected";
  if (status >= 500) return "server-error";
  return "not-opensesame";
}

/**
 * One sentence an operator can act on. These are the strings the ceremony and
 * the connector tiles show, so they name the next move, not the error code.
 */
export function failureSentence(failure: FailureClass, what: string): string {
  switch (failure) {
    case "offline":
      return "This device is offline. Checks resume when the network is back.";
    case "timeout":
      return `${what} did not answer in time. It may be starting up, or the tailnet may be slow.`;
    case "unreachable":
      return `Nothing answered. Check ${what} is running, and that this page is allowed to reach it.`;
    case "rejected":
      return `${what} answered but refused the request. Its credentials need renewing.`;
    case "server-error":
      return `${what} answered with an error of its own. Its logs will say more than this page can.`;
    case "not-opensesame":
      return `Something is listening at ${what}, but it is not the OpenSesame service. Check the port.`;
  }
}

/** Short form, for the one line under a connector's name. */
export function failureLabel(failure: FailureClass, base: string): string {
  switch (failure) {
    case "offline":
      return "Offline";
    case "timeout":
      return `No answer in time · ${base}`;
    case "unreachable":
      return `Unreachable · ${base}`;
    case "rejected":
      return `Refused the request · ${base}`;
    case "server-error":
      return `Erroring · ${base}`;
    case "not-opensesame":
      return `Not OpenSesame · ${base}`;
  }
}
