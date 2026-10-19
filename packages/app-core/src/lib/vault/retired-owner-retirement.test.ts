/** Real owner crypto and original transport closures; independent cleanup failures must survive cancellation. */
import { expect, test } from "vitest";
import { RetiredOperationExchange } from "./retired-operation-exchange.js";
interface RetirementRefusal {
  cause: unknown;
}
import {
  OWNER_PASSWORD,
  retiredOwnerFixture,
} from "./retired-owner.fixture.js";
const primary = { kind: "password" as const, secret: OWNER_PASSWORD };
async function rejection<T>(promise: Promise<T>): Promise<RetirementRefusal> {
  try {
    await promise;
  } catch (cause) {
    return { cause };
  }
  throw new Error("Expected retirement refusal.");
}
function contains(cause: unknown, expected: Error): boolean {
  return (
    Object.is(cause, expected) ||
    (cause instanceof AggregateError &&
      cause.errors.some((inner) => contains(inner, expected)))
  );
}
test("ordinary factor cancellation drains and resolves without invented disposal failure", async () => {
  const f = await retiredOwnerFixture(true);
  try {
    const operation = await f.store.beginRetired(primary, { kind: "inspect" });
    if (operation.kind !== "challenge")
      throw new Error("Factor challenge missing.");
    await operation.cancel();
    expect(f.held).toEqual([]);
    expect(f.closed()).toBeGreaterThanOrEqual(3);
  } finally {
    f.dispose();
  }
});
test("factor cancellation retains original independent native close failures", async () => {
  const f = await retiredOwnerFixture(true);
  const closeFailure = new Error("original native reader close refused");
  try {
    const operation = await f.store.beginRetired(primary, { kind: "inspect" });
    if (operation.kind !== "challenge")
      throw new Error("Factor challenge missing.");
    f.failCloses(closeFailure);
    const outcome = await rejection(operation.cancel());
    expect(contains(outcome.cause, closeFailure)).toBe(true);
    expect(outcome.cause).toBeInstanceOf(AggregateError);
    expect(f.held).toEqual([]);
  } finally {
    f.failCloses(undefined);
    f.dispose();
  }
});
test("factor cancellation retains actual credential lease release failure", async () => {
  const f = await retiredOwnerFixture(true);
  const releaseFailure = new Error("original credential lease release refused");
  try {
    const operation = await f.store.beginRetired(primary, { kind: "inspect" });
    if (operation.kind !== "challenge")
      throw new Error("Factor challenge missing.");
    f.failCredentialRelease(releaseFailure);
    expect(
      contains((await rejection(operation.cancel())).cause, releaseFailure),
    ).toBe(true);
    expect(f.held).toEqual([]);
  } finally {
    f.failCredentialRelease(undefined);
    f.dispose();
  }
});
test("pre-handle abort waits for original cleanup and preserves close failure", async () => {
  const f = await retiredOwnerFixture();
  const closeFailure = new Error("original pre-handle close refused");
  const controller = new AbortController();
  try {
    const accepted = f.store.beginRetired(
      primary,
      { kind: "inspect" },
      controller.signal,
    );
    await f.deviceCaptured;
    f.failCloses(closeFailure);
    controller.abort();
    expect(contains((await rejection(accepted)).cause, closeFailure)).toBe(
      true,
    );
    expect(f.held).toEqual([]);
  } finally {
    f.failCloses(undefined);
    f.dispose();
  }
});

test("private diagnostic collection is bounded and reports additional failures explicitly", async () => {
  const exchange = new RetiredOperationExchange(new AbortController().signal);
  const failure = new Error("native failure");
  for (let index = 0; index < 130; index++)
    exchange.recordDrainFailure(failure);
  exchange.track(Promise.resolve());
  const outcome = await rejection(exchange.drain());
  expect(outcome.cause).toBeInstanceOf(AggregateError);
  if (!(outcome.cause instanceof AggregateError))
    throw new Error("Aggregate diagnostic missing.");
  expect(outcome.cause.errors).toHaveLength(129);
  expect(outcome.cause.errors.at(-1)?.message).toContain(
    "2 additional disposal failures",
  );
});
