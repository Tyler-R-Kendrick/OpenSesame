import {
  type ReplicateConnection,
  type ReplicateInput,
  type ReplicatePrediction,
  ReplicatePredictionInterrupted,
  type ReplicateRunOptions,
} from "./replicate-types.js";
import {
  cancelReplicatePrediction,
  createReplicatePrediction,
  getReplicatePrediction,
} from "./replicate.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Prediction waiting stopped.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function timing(options: ReplicateRunOptions) {
  const interval = options.pollIntervalMs ?? 1000;
  const timeout = options.timeoutMs ?? 180_000;
  if (
    !Number.isInteger(interval) ||
    interval < 10 ||
    interval > 10_000 ||
    !Number.isInteger(timeout) ||
    timeout < 100 ||
    timeout > 300_000
  )
    throw new AiConnectionError(
      "configuration",
      "Choose bounded prediction polling and timeout values.",
    );
  return { interval, timeout };
}

/** Only terminal successful output is inference; metadata alone never verifies a model. */
export async function runReplicatePrediction(
  config: ReplicateConnection,
  input: ReplicateInput,
  transport: AiConnectionTransport,
  check: () => void,
  options: ReplicateRunOptions = {},
): Promise<ReplicatePrediction> {
  const { interval, timeout } = timing(options);
  const signals = [transport.signal, AbortSignal.timeout(timeout)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  const operation = { ...transport, signal };
  const assert = () => {
    check();
    transport.assertCurrent();
    signal.throwIfAborted();
  };
  let current: ReplicatePrediction | undefined;
  let terminal = false;
  try {
    current = await createReplicatePrediction(config, input, operation, check);
    for (;;) {
      assert();
      terminal = ["succeeded", "failed", "canceled"].includes(current.status);
      options.onPrediction?.(current);
      assert();
      if (current.status === "succeeded") {
        if (current.output === undefined || current.output === null)
          throw new AiConnectionError(
            "response",
            "The prediction completed without output.",
          );
        assert();
        return current;
      }
      if (current.status === "failed")
        throw new AiConnectionError(
          "response",
          "The Replicate prediction failed.",
        );
      if (current.status === "canceled")
        throw new AiConnectionError(
          "response",
          "The Replicate prediction was canceled.",
        );
      await pause(interval, signal);
      current = await getReplicatePrediction(
        config,
        current.id,
        operation,
        check,
      );
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    // A user abort can request remote cancellation. A lock/replacement cannot
    // send another authenticated request after the credential's custody ends.
    check();
    transport.assertCurrent();
    transport.signal.throwIfAborted();
    let requested = false;
    if (current && !terminal) {
      try {
        await cancelReplicatePrediction(
          config,
          current.id,
          {
            ...transport,
            signal: AbortSignal.any([
              transport.signal,
              AbortSignal.timeout(10_000),
            ]),
          },
          check,
        );
        requested = true;
      } catch {
        check();
        transport.assertCurrent();
        transport.signal.throwIfAborted();
      }
    }
    throw new ReplicatePredictionInterrupted(requested);
  }
}
