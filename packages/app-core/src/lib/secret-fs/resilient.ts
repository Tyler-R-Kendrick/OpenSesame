/**
 * The resilience a secret file store needs once it is a network away
 * (ADR 0182): the PWA served from one machine and the secrets kept on another
 * is a store that is sometimes slow, sometimes gone and sometimes answers
 * after the caller has stopped waiting. Wrapping a store here adds, to any
 * backend and identically:
 *
 * - a time limit on every attempt, so a hung socket is a failure and not a
 *   frozen vault;
 * - bounded retries with exponential backoff and jitter, for the failures
 *   worth retrying and no others (`isTransient`) — a refusal, a conflict and
 *   an absent file are answers, not outages;
 * - a circuit breaker, so a store that has been failing is not hammered by
 *   every keystroke, and is probed by one request once it has had time;
 * - an honest retry of a write: replacing a file with the same bytes is safe
 *   to repeat, and a retry that finds its own bytes already there — the first
 *   attempt landed and only the answer was lost — is the write succeeding,
 *   not a conflict.
 *
 * It never retries a conflict: a rival write is the caller's to resolve.
 */
import { Clock, Duration, Effect, type Exit, Ref, Schedule } from "effect";
import { SecretFsUnavailable, isTransient } from "./errors.js";
import type { SecretFsError } from "./errors.js";
import { revisionOf } from "./files.js";
import type { SecretFiles } from "./files.js";

export type ResiliencePolicy = Readonly<{
  /** Attempts after the first. */
  retries: number;
  /** The first backoff; each retry waits about twice as long, jittered. */
  backoff: Duration.Input;
  /** How long one attempt may take before it counts as a failure. */
  attemptTimeout: Duration.Input;
  /** Failures in a row (retries spent) that open the circuit. */
  breakerThreshold: number;
  /** How long an open circuit stays open before one request probes it. */
  breakerReset: Duration.Input;
}>;

export const DEFAULT_RESILIENCE: ResiliencePolicy = {
  retries: 4,
  backoff: "100 millis",
  attemptTimeout: "10 seconds",
  breakerThreshold: 3,
  breakerReset: "30 seconds",
};

type Breaker = Readonly<{
  failures: number;
  openedAt: number | null;
  probing: boolean;
}>;

const CLOSED: Breaker = { failures: 0, openedAt: null, probing: false };

/** The circuit's two moves: let a request through (or refuse it), and learn how it went. */
type Circuit = Readonly<{
  admit: (path: string) => Effect.Effect<void, SecretFsError>;
  settle: (outcome: "reached" | "unreachable") => Effect.Effect<void>;
}>;

function makeCircuit(
  state: Ref.Ref<Breaker>,
  policy: ResiliencePolicy,
): Circuit {
  const resetMillis = Duration.toMillis(policy.breakerReset);
  return {
    admit: (path) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const allowed = yield* Ref.modify(
          state,
          (current): [boolean, Breaker] => {
            if (current.openedAt === null) return [true, current];
            if (now - current.openedAt < resetMillis || current.probing) {
              return [false, current];
            }
            return [true, { ...current, probing: true }];
          },
        );
        if (!allowed) {
          return yield* new SecretFsUnavailable({
            path,
            reason: "the store has been failing; not trying it again yet",
          });
        }
      }),
    settle: (outcome) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.update(state, (current): Breaker => {
            if (outcome === "reached") return CLOSED;
            const failures = current.failures + 1;
            return failures >= policy.breakerThreshold ||
              current.openedAt !== null
              ? { failures, openedAt: now, probing: false }
              : { ...current, failures };
          }),
        ),
      ),
  };
}

/** Whether a failed attempt says the store itself could not be reached. */
function unreachable<A>(outcome: Exit.Exit<A, SecretFsError>): boolean {
  return (
    outcome._tag === "Failure" &&
    outcome.cause.reasons.some(
      (reason) => reason._tag === "Fail" && isTransient(reason.error),
    )
  );
}

/** One logical operation: admitted by the circuit, bounded in time, retried while unreachable. */
function guarded<A>(
  circuit: Circuit,
  policy: ResiliencePolicy,
  path: string,
  attempt: Effect.Effect<A, SecretFsError>,
): Effect.Effect<A, SecretFsError> {
  return Effect.gen(function* () {
    yield* circuit.admit(path);
    const bounded = attempt.pipe(
      Effect.timeoutOrElse({
        duration: policy.attemptTimeout,
        orElse: () =>
          Effect.fail(new SecretFsUnavailable({ path, reason: "timed out" })),
      }),
    );
    const outcome = yield* bounded.pipe(
      Effect.retry({
        schedule: Schedule.exponential(policy.backoff).pipe(Schedule.jittered),
        times: policy.retries,
        while: isTransient,
      }),
      Effect.exit,
    );
    // Only an unreachable store counts against the circuit: a missing file or
    // a refusal came from a store that is working.
    yield* circuit.settle(unreachable(outcome) ? "unreachable" : "reached");
    return yield* outcome;
  });
}

/**
 * A write is retried as the same bytes, and a retry that finds its own
 * revision already stored after an unreachable answer is the write succeeding.
 */
function guardedWrite(
  files: SecretFiles,
  circuit: Circuit,
  policy: ResiliencePolicy,
): SecretFiles["write"] {
  return (path, bytes, options) => {
    const landed = revisionOf(bytes);
    return Effect.suspend(() => {
      // Only an unreachable store is retried (a timeout is one), so a second
      // try means the first may have landed with its answer lost.
      let tries = 0;
      return guarded(
        circuit,
        policy,
        path,
        Effect.suspend(() => {
          tries += 1;
          return files.write(path, bytes, options);
        }).pipe(
          Effect.catchTag("SecretFsConflict", (conflict) =>
            tries > 1 && conflict.actual === landed
              ? Effect.succeed(landed)
              : Effect.fail(conflict),
          ),
        ),
      );
    });
  };
}

export function resilient(
  files: SecretFiles,
  overrides: Partial<ResiliencePolicy> = {},
): Effect.Effect<SecretFiles> {
  const policy = { ...DEFAULT_RESILIENCE, ...overrides };
  return Effect.gen(function* () {
    const circuit = makeCircuit(yield* Ref.make<Breaker>(CLOSED), policy);
    return {
      read: (path) => guarded(circuit, policy, path, files.read(path)),
      write: guardedWrite(files, circuit, policy),
      remove: (path) => guarded(circuit, policy, path, files.remove(path)),
      list: (prefix) => guarded(circuit, policy, prefix, files.list(prefix)),
    };
  });
}
