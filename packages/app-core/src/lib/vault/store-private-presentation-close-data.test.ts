/** Explicit accepted close callback doubles; cleanup custody only, no principal/platform proof. */
import { expect, it } from "vitest";
import { disposeOriginalCommandData } from "./original-command-retirement-data.js";
import {
  closePrivatePresentationData,
  drainPrivatePresentationData,
} from "./store-private-presentation-close-data.js";
type Outcome = { kind: "fulfilled" } | { kind: "rejected"; cause: unknown };
type Tracked = {
  outcome: Promise<Outcome>;
  settled: boolean;
  verified: boolean;
};
function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Fixture = {
  delivery: ReturnType<typeof gate>;
  tasks: Tracked[];
};
function track(f: Fixture, task: Promise<void>): Tracked {
  const tracked: Tracked = {
    settled: false,
    verified: false,
    outcome: task.then(
      (): Outcome => {
        tracked.settled = true;
        return { kind: "fulfilled" };
      },
      (cause): Outcome => {
        tracked.settled = true;
        return { kind: "rejected", cause };
      },
    ),
  };
  f.tasks.push(tracked);
  return tracked;
}
async function finishTask(task: Tracked) {
  const outcome = await task.outcome;
  if (!task.verified && outcome.kind === "rejected") throw outcome.cause;
}
async function owned(work: (f: Fixture) => Promise<void>) {
  const f: Fixture = { delivery: gate(), tasks: [] };
  let failure: ErrorOptions | undefined;
  try {
    await work(f);
  } catch (cause) {
    failure = { cause };
  }
  const drains = f.tasks.map((task) => () => finishTask(task));
  await disposeOriginalCommandData(failure, undefined, [
    async () => f.delivery.release(),
    ...drains,
  ]);
}
async function reentrantAcceptedClose(f: Fixture) {
  const retiring = new Set<Promise<void>>();
  let selected: Tracked | undefined;
  const closed = track(
    f,
    closePrivatePresentationData(
      {
        close: () => {
          selected = track(f, drainPrivatePresentationData([...retiring]));
          return f.delivery.promise;
        },
      },
      retiring,
    ),
  );
  expect(retiring.size).toBe(1);
  if (!selected) throw new Error("Original reentrant drain absent.");
  await Promise.resolve();
  expect(selected.settled).toBe(false);
  f.delivery.release();
  const originalClose = await closed.outcome;
  const originalDrain = await selected.outcome;
  expect(originalClose.kind).toBe("fulfilled");
  expect(originalDrain.kind).toBe("fulfilled");
  expect(selected.settled).toBe(true);
  expect(retiring.size).toBe(0);
  closed.verified = true;
  selected.verified = true;
}
it("reserves before original close reentry and drains an already-retiring accepted task", () =>
  owned(reentrantAcceptedClose));
async function originalRefusedClose(f: Fixture) {
  const retiring = new Set<Promise<void>>();
  const failure = new Error("Original close failure.");
  const closed = track(
    f,
    closePrivatePresentationData(
      {
        close: async () => {
          await f.delivery.promise;
          throw failure;
        },
      },
      retiring,
    ),
  );
  const drained = track(f, drainPrivatePresentationData([...retiring]));
  f.delivery.release();
  const originalDrain = await drained.outcome;
  const originalClose = await closed.outcome;
  if (originalDrain.kind !== "rejected" || originalClose.kind !== "rejected")
    throw new Error("Original rejected cleanup was normalized.");
  expect(Object.is(originalDrain.cause, failure)).toBe(true);
  expect(Object.is(originalClose.cause, failure)).toBe(true);
  expect(retiring.size).toBe(0);
  drained.verified = true;
  closed.verified = true;
}
it("reports the original rejected tracked close instead of normalizing old retirement to success", () =>
  owned(originalRefusedClose));
