/** Captured controlled HTTP transport DATA; actual caller owns accepted work through native cleanup. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  CONTROLLED_CANARY_REQUEST_BYTES,
  ControlledCanaryChallengeSchema,
  type ControlledCanaryCommand,
  ControlledCanaryResultSchema,
} from "./controlled-receiver-contract.js";
import { readOriginalControlledResponseData } from "./original-controlled-response-data.js";
import {
  type CanaryReceiverProfile,
  copyCanaryReceiverProfile,
} from "./receiver-profile-data.js";
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
const originalSetTimeout = setTimeout;
const originalClearTimeout = clearTimeout;
function unavailable(): never {
  throw new Error("Controlled canary receiver unavailable.");
}
function refuse<T>(failures: readonly T[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Original controlled request and drain failed.",
    );
}
type OriginalControlledRequest = Readonly<{
  request: typeof fetch;
  check: () => void;
  listen: AbortSignal["addEventListener"];
  unlisten: AbortSignal["removeEventListener"];
}>;
function captureOriginalControlledRequest(
  original: () => void,
  signal: AbortSignal,
): OriginalControlledRequest {
  const provider = globalThis.fetch;
  const request: typeof fetch = bindOriginal(provider, globalThis);
  const add = signal.addEventListener;
  const remove = signal.removeEventListener;
  const listen: typeof add = bindOriginal(add, signal);
  const unlisten: typeof remove = bindOriginal(remove, signal);
  const check = () => {
    original();
    if (
      globalThis.fetch !== provider ||
      signal.aborted ||
      signal.addEventListener !== add ||
      signal.removeEventListener !== remove
    )
      unavailable();
    original();
  };
  return { request, check, listen, unlisten };
}
/** The signal cancels only this captured request; no scheduling or copied transport establishes authority. */
export function captureControlledCanaryClientData(
  receiver: CanaryReceiverProfile,
  original: () => void,
  signal: AbortSignal,
) {
  const profile = copyCanaryReceiverProfile(receiver);
  const { request, check, listen, unlisten } = captureOriginalControlledRequest(
    original,
    signal,
  );
  check();
  const post = async (
    path: "challenge" | "execute",
    value: BoundaryValue,
  ): Promise<BoundaryValue> => {
    const body = JSON.stringify(value);
    if (new TextEncoder().encode(body).length > CONTROLLED_CANARY_REQUEST_BYTES)
      unavailable();
    const controller = new AbortController();
    const originalAbort: AbortController["abort"] = bindOriginal(
      controller.abort,
      controller,
    );
    const drainFailures: unknown[] = [];
    const abort = () => {
      try {
        originalAbort();
      } catch (cause) {
        drainFailures.push(cause);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: ErrorOptions | undefined;
    let result: BoundaryValue | undefined;
    try {
      timer = originalSetTimeout(abort, 30000);
      listen("abort", abort, { once: true });
      check();
      const response = await request(
        `${profile.endpoint}/v1/agent-canaries/${path}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: profile.browserOrigin,
          },
          body,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        },
      );
      const responseCheck = () => {
        check();
        if (controller.signal.aborted) unavailable();
      };
      result = await readOriginalControlledResponseData({
        response,
        original: responseCheck,
        abort: originalAbort,
      });
      responseCheck();
    } catch (cause) {
      failure = { cause };
    }
    if (failure) {
      try {
        originalAbort();
      } catch (cause) {
        drainFailures.push(cause);
      }
    }
    for (const cleanup of [
      () => originalClearTimeout(timer),
      () => unlisten("abort", abort),
    ]) {
      try {
        cleanup();
      } catch (cause) {
        drainFailures.push(cause);
      }
    }
    refuse(failure ? [failure.cause, ...drainFailures] : drainFailures);
    if (result === undefined) unavailable();
    return result;
  };
  return Object.freeze({
    challenge: async (command: ControlledCanaryCommand) =>
      ControlledCanaryChallengeSchema.parse(await post("challenge", command)),
    execute: async (signed: Readonly<{ nonce: string; idToken: string }>) =>
      ControlledCanaryResultSchema.parse(await post("execute", signed)),
  });
}
