/** Native AES ground truth; held crypto/slot deliveries are explicit doubles, never authentication. */
import { importVaultKey } from "@opensesame/vault-core";
import { vi } from "vitest";
import {
  disposeOriginalCommandData,
  refuseOriginalCommandOutcomes,
} from "../vault/original-command-retirement-data.js";
import type { captureIndexedCanarySlotCustodyData } from "./indexed-slot-custody-data.js";
import {
  type CanaryIndexedSealData,
  captureOriginalCanaryIndexedSealData,
} from "./original-indexed-seal-data.js";
type Outcome<T> =
  | { kind: "fulfilled"; value: T }
  | { kind: "rejected"; cause: unknown };
export type Observed<T> = {
  promise: Promise<T>;
  outcome: Promise<Outcome<T>>;
  settled: boolean;
  verified: boolean;
};
export function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export type Fixture = {
  raw: Uint8Array<ArrayBuffer>;
  key: CryptoKey | undefined;
  seal: CanaryIndexedSealData | undefined;
  closing: Observed<void> | undefined;
  custody: ReturnType<typeof captureIndexedCanarySlotCustodyData> | undefined;
  custodyDrain: Observed<void> | undefined;
  tasks: Observed<unknown>[];
  bytes: Uint8Array[];
  deliveries: ReturnType<typeof gate>[];
  restores: (() => void)[];
};
export function observe<T>(f: Fixture, promise: Promise<T>): Observed<T> {
  const tracked: Observed<T> = {
    promise,
    settled: false,
    verified: false,
    outcome: promise.then(
      (value): Outcome<T> => {
        tracked.settled = true;
        return { kind: "fulfilled", value };
      },
      (cause): Outcome<T> => {
        tracked.settled = true;
        return { kind: "rejected", cause };
      },
    ),
  };
  f.tasks.push(tracked);
  return tracked;
}
export function observeCall<T>(
  f: Fixture,
  call: () => T,
): Observed<Awaited<T>> {
  try {
    return observe(f, Promise.resolve(call()));
  } catch (cause) {
    return observe(f, Promise.reject<Awaited<T>>(cause));
  }
}
export async function awaitEntered<T>(
  entered: Promise<void>,
  task: Observed<T>,
) {
  const result = await Promise.race([
    entered.then(() => ({ kind: "entered" as const })),
    task.outcome.then((outcome) => ({ kind: "settled" as const, outcome })),
  ]);
  if (result.kind === "settled") {
    if (result.outcome.kind === "rejected") throw result.outcome.cause;
    throw new Error("Original task settled before native delivery entered.");
  }
}
export function keyOf(f: Fixture): CryptoKey {
  if (!f.key) throw new Error("Original native test key missing.");
  return f.key;
}
export function sealOf(f: Fixture): CanaryIndexedSealData {
  if (!f.seal) throw new Error("Original native test seal missing.");
  return f.seal;
}
export async function rejected<T>(task: Observed<T>) {
  const outcome = await task.outcome;
  if (outcome.kind !== "rejected")
    throw new Error("Expected original refusal did not occur.");
  return { cause: outcome.cause };
}
export function verifyAll(f: Fixture) {
  for (const task of f.tasks) task.verified = true;
}
export function closeSeal(f: Fixture): Observed<void> {
  if (!f.closing) f.closing = observe(f, sealOf(f).close());
  return f.closing;
}
export function heldNativeDecrypt(f: Fixture) {
  const native = crypto.subtle.decrypt;
  const entered = gate();
  const held = gate();
  f.deliveries.push(entered, held);
  const spy = vi
    .spyOn(crypto.subtle, "decrypt")
    .mockImplementation(async (...args) => {
      const actual = await native.apply(crypto.subtle, args);
      f.bytes.push(new Uint8Array(actual));
      entered.release();
      await held.promise;
      return actual;
    });
  return { entered, held, spy };
}
async function drainObserved(f: Fixture) {
  const failures: unknown[] = [];
  for (const task of f.tasks) {
    const outcome = await task.outcome;
    if (!task.verified && outcome.kind === "rejected")
      failures.push(outcome.cause);
  }
  refuseOriginalCommandOutcomes(failures);
}
async function closeCrypto(f: Fixture) {
  if (f.seal) closeSeal(f);
}
async function closeSlot(f: Fixture) {
  if (f.custody && !f.custodyDrain)
    f.custodyDrain = observe(f, f.custody.drain());
}
async function wipeDelivered(f: Fixture) {
  const failures: unknown[] = [];
  for (const bytes of f.bytes) {
    try {
      bytes.fill(0);
    } catch (cause) {
      failures.push(cause);
    }
  }
  refuseOriginalCommandOutcomes(failures);
}
export async function owned(work: (f: Fixture) => Promise<void>) {
  const f: Fixture = {
    raw: new Uint8Array(32),
    key: undefined,
    seal: undefined,
    closing: undefined,
    custody: undefined,
    custodyDrain: undefined,
    tasks: [],
    bytes: [],
    deliveries: [],
    restores: [],
  };
  let failure: ErrorOptions | undefined;
  try {
    crypto.getRandomValues(f.raw);
    f.key = await importVaultKey(f.raw);
    await work(f);
  } catch (cause) {
    failure = { cause };
  }
  const restores = f.restores.map((restore) => async () => restore());
  const releases = f.deliveries.map(
    (delivery) => async () => delivery.release(),
  );
  await disposeOriginalCommandData(failure, undefined, [
    ...releases,
    () => closeCrypto(f),
    () => closeSlot(f),
    () => drainObserved(f),
    ...restores,
    async () => {
      vi.restoreAllMocks();
    },
    async () => {
      f.raw.fill(0);
    },
    () => wipeDelivered(f),
  ]);
}
export function originalSeal(f: Fixture) {
  f.seal = captureOriginalCanaryIndexedSealData(() => {});
  return f.seal;
}
