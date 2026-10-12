/** Direct original diagnostic helper controls; no provider, lease or authentication simulation. */
import { expect, it } from "vitest";
import {
  disposeOriginalCommandData,
  observeOriginalCommandLeaseData,
} from "./original-command-retirement-data.js";

async function rejected<T>(task: Promise<T>) {
  const outcome = await task.then(
    (value) => ({ accepted: true as const, value }),
    (cause: unknown) => ({ accepted: false as const, cause }),
  );
  expect(outcome.accepted).toBe(false);
  if (outcome.accepted)
    throw new Error("Original helper unexpectedly fulfilled.");
  return { cause: outcome.cause };
}

it.each([undefined, Number.NaN, -0, new Error("Original callback refusal.")])(
  "preserves exact forwarded callback cause %s without recording disposal failure",
  async (cause) => {
    const recorded: unknown[] = [];
    const { cause: actual } = await rejected(
      observeOriginalCommandLeaseData(
        (failure) => {
          recorded.push(failure);
        },
        (work) => work(),
        async () => {
          throw cause;
        },
      ),
    );
    expect(Object.is(actual, cause)).toBe(true);
    expect(recorded).toEqual([]);
  },
);

it("retains a Promise-valued callback refusal without adopting its alias", async () => {
  const alias = Promise.resolve("Original independently owned task result.");
  const recorded: unknown[] = [];
  const { cause } = await rejected(
    observeOriginalCommandLeaseData(
      (failure) => {
        recorded.push(failure);
      },
      (work) => work(),
      async () => {
        throw alias;
      },
    ),
  );
  expect(cause).toBe(alias);
  expect(recorded).toEqual([]);
});

it.each([
  [undefined, undefined],
  [undefined, Number.NaN],
  [Number.NaN, undefined],
  [Number.NaN, Number.NaN],
])(
  "retains original lease refusal %s and independent recorder refusal %s",
  async (cause, reported) => {
    const recorded: unknown[] = [];
    let entered = false;
    const { cause: actual } = await rejected(
      observeOriginalCommandLeaseData(
        (failure) => {
          recorded.push(failure);
          throw reported;
        },
        async () => {
          throw cause;
        },
        async () => {
          entered = true;
        },
      ),
    );
    expect(entered).toBe(false);
    expect(recorded).toHaveLength(1);
    expect(Object.is(recorded[0], cause)).toBe(true);
    expect(actual).toBeInstanceOf(AggregateError);
    if (!(actual instanceof AggregateError))
      throw new Error("Original dual causes missing.");
    const failures: unknown[] = Array.from(actual.errors);
    expect(failures).toHaveLength(2);
    expect(Object.is(failures[0], cause)).toBe(true);
    expect(Object.is(failures[1], reported)).toBe(true);
  },
);

it("independently attempts every disposal and retains undefined work plus recorder causes", async () => {
  const attempts: number[] = [];
  const recorded: unknown[] = [];
  const reporting = new Error("Original recorder refusal.");
  const { cause: actual } = await rejected(
    disposeOriginalCommandData(
      { cause: undefined },
      (cause) => {
        recorded.push(cause);
        throw reporting;
      },
      [
        async () => {
          attempts.push(1);
          throw Number.NaN;
        },
        async () => {
          attempts.push(2);
        },
        async () => {
          attempts.push(3);
          throw undefined;
        },
      ],
    ),
  );
  expect(attempts).toEqual([1, 2, 3]);
  expect(recorded).toHaveLength(2);
  expect(Object.is(recorded[0], Number.NaN)).toBe(true);
  expect(recorded[1]).toBeUndefined();
  expect(actual).toBeInstanceOf(AggregateError);
  if (!(actual instanceof AggregateError))
    throw new Error("Original disposal causes missing.");
  const failures: unknown[] = Array.from(actual.errors);
  expect(failures).toEqual([
    undefined,
    Number.NaN,
    reporting,
    undefined,
    reporting,
  ]);
});
