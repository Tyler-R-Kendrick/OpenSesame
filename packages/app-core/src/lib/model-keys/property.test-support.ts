/**
 * The generators behind the stateful property: a root's models and budget, and
 * a sequence of operations (exchange, call, settle, revoke, wait) weighted
 * toward requests that could succeed, so a run reaches the checks that matter
 * and still meets some that cannot.
 */
import fc from "fast-check";

export const POOL = [
  "gpt-4o",
  "gpt-4o-mini",
  "o1",
  "anthropic/claude",
  "anthropic/haiku",
  "anthropic/*",
  "*",
];
export const ROOT_BUDGET = {
  requests: 100,
  input_tokens: 100_000,
  output_tokens: 50_000,
  max_output_tokens: 4096,
};

export type ExchangeOp = {
  kind: "exchange";
  from: number;
  models: string[] | null;
  actions: string[] | null;
  budget: Record<string, number> | null;
  lifetime: number | null;
};
export type CallOp = {
  kind: "call";
  key: number;
  model: string;
  maxTokens: number;
  list: boolean;
};
export type SettleOp = { kind: "settle"; slot: number; sent: boolean };
export type RevokeOp = { kind: "revoke"; key: number };
export type WaitOp = { kind: "wait"; seconds: number };
export type Op = ExchangeOp | CallOp | SettleOp | RevokeOp | WaitOp;

const amount = (max: number) => fc.integer({ min: 0, max });
const smallBudget = fc.record({
  requests: amount(30),
  input_tokens: amount(20_000),
  output_tokens: amount(12_000),
  max_output_tokens: fc.integer({ min: 1, max: 4096 }),
});
const wildBudget = fc.record({
  requests: amount(150),
  input_tokens: amount(150_000),
  output_tokens: amount(80_000),
  max_output_tokens: fc.integer({ min: 1, max: 6000 }),
});

const exchangeOp = (rootModels: readonly string[]): fc.Arbitrary<ExchangeOp> =>
  fc.record({
    kind: fc.constant("exchange" as const),
    from: fc.nat(8),
    models: fc.option(
      fc.oneof(
        {
          weight: 4,
          arbitrary: fc.subarray([...rootModels], { minLength: 1 }),
        },
        { weight: 1, arbitrary: fc.subarray(POOL, { minLength: 1 }) },
      ),
      { nil: null },
    ),
    actions: fc.option(
      fc.subarray(["model.invoke", "model.list"], { minLength: 1 }),
      { nil: null },
    ),
    budget: fc.oneof(
      { weight: 6, arbitrary: smallBudget },
      { weight: 1, arbitrary: wildBudget },
      { weight: 1, arbitrary: fc.constant(null) },
    ),
    lifetime: fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: null }),
  });

const callOp = (rootModels: readonly string[]): fc.Arbitrary<CallOp> => {
  const concrete = rootModels.filter((model) => !model.includes("*"));
  return fc.record({
    kind: fc.constant("call" as const),
    key: fc.nat(8),
    model: fc.oneof(
      {
        weight: 4,
        arbitrary: fc.constantFrom(
          ...(concrete.length > 0 ? concrete : ["gpt-4o"]),
        ),
      },
      {
        weight: 1,
        arbitrary: fc.constantFrom(
          ...POOL.filter((m) => !m.includes("*")),
          "gpt-4",
          "anthropic/other",
        ),
      },
    ),
    maxTokens: fc.oneof(
      { weight: 5, arbitrary: fc.integer({ min: 1, max: 400 }) },
      { weight: 1, arbitrary: fc.integer({ min: 1, max: 6000 }) },
    ),
    list: fc.boolean(),
  });
};

const settleOp = fc.record({
  kind: fc.constant("settle" as const),
  slot: fc.nat(8),
  sent: fc.boolean(),
});
const revokeOp = fc.record({
  kind: fc.constant("revoke" as const),
  key: fc.nat(8),
});
const waitOp = fc.record({
  kind: fc.constant("wait" as const),
  seconds: fc.integer({ min: 1, max: 3000 }),
});

/** Mostly requests that could succeed, so the run reaches the checks that matter, and some that cannot. */
const opFor = (rootModels: readonly string[]): fc.Arbitrary<Op> =>
  fc.oneof(
    { weight: 6, arbitrary: exchangeOp(rootModels) },
    { weight: 5, arbitrary: callOp(rootModels) },
    { weight: 2, arbitrary: settleOp },
    { weight: 1, arbitrary: revokeOp },
    { weight: 1, arbitrary: waitOp },
  );

/** A root's models, and a run of operations drawn for those models. */
export const scenario = fc
  .subarray(POOL, { minLength: 1, maxLength: 4 })
  .chain((rootModels) =>
    fc.tuple(
      fc.constant(rootModels),
      fc.array(opFor(rootModels), { minLength: 4, maxLength: 24 }),
    ),
  );
