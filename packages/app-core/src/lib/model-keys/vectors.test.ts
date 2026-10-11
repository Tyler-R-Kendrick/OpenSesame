/**
 * The model-key conformance vectors (ADR 0139, ADR 0190), replayed.
 *
 * `spec/conformance/model-key-exchange-vectors.json` is the one statement of
 * what an exchange and a last-hop check decide. This file is the TypeScript
 * consumer: it builds a broker from the file's own policy and providers, issues
 * each case's root through the real approval prover, and runs the steps in
 * order. A case that no longer holds is a behaviour change, not a test to edit.
 */
import { readFileSync } from "node:fs";
import { name } from "@gdp-ts/core";
import type { JsonObject } from "@opensesame/os-domain";
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { proveModelGrantApproved } from "../proofs/model-grant-approval.js";
import { ModelKeyBroker } from "./broker.js";
import { ModelKeyRefusal } from "./errors.js";
import { type ModelGrantDraft, modelGrantDigest } from "./root.js";
import { DEFAULT_POLICY } from "./types.js";
import {
  ACCESS_TOKEN_TYPE,
  ACTIONS,
  TOKEN_EXCHANGE_GRANT,
} from "./vocabulary.js";

type Refused = Readonly<{ error: string; reason: string }>;

/**
 * The shape of `model-key-exchange-vectors.json`, written as a schema so a
 * malformed or misspelled vector fails loudly instead of being read as an
 * absent field (an ignored `settel` would be a step that silently asserts less).
 * Every object is strict: a key the schema does not name is an error.
 */
const nonNegative = z.number().int().nonnegative();
const jsonObject = z.record(z.string(), z.json());
const refusedSchema = z.strictObject({ error: z.string(), reason: z.string() });
const stepSchema = z.strictObject({
  op: z.enum(["exchange", "call", "revoke", "advance"]),
  from: z.string().optional(),
  key: z.string().optional(),
  as: z.string().optional(),
  client: z.string().optional(),
  resource: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
  details: jsonObject.optional(),
  operation: z.enum(["invoke", "list"]).optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  body: z.json().optional(),
  seconds: nonNegative.optional(),
  settle: z.strictObject({ sent: z.boolean() }).optional(),
  expect: z
    .strictObject({
      issued: jsonObject.optional(),
      refused: refusedSchema.optional(),
      allowed: jsonObject.optional(),
    })
    .optional(),
});
const vectorsSchema = z.strictObject({
  schema_version: z.literal(1),
  description: z.string(),
  now_ms: nonNegative,
  policy: z.strictObject({
    senderConstraint: z.enum(["dpop_required", "dpop_optional"]),
    rootMaxLifetimeSeconds: nonNegative,
    maxLifetimeSeconds: nonNegative,
    defaultLifetimeSeconds: nonNegative,
    maxDelegationDepth: nonNegative,
    outputTokenCeiling: nonNegative,
  }),
  providers: z
    .array(
      z.strictObject({
        providerId: z.string(),
        protocol: z.enum([
          "openai_chat",
          "anthropic_messages",
          "gemini_generate_content",
        ]),
        baseUrl: z.string(),
        connectionId: z.string(),
      }),
    )
    .min(1),
  cases: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        root: z.strictObject({
          clientId: z.string(),
          resource: z.string(),
          actions: z.array(z.enum(ACTIONS)),
          models: z.array(z.string()),
          budget: z.strictObject({
            requests: nonNegative,
            input_tokens: nonNegative,
            output_tokens: nonNegative,
            max_output_tokens: nonNegative,
          }),
          lifetimeSeconds: nonNegative,
          maximumDelegationDepth: nonNegative,
        }),
        steps: z.array(stepSchema).min(1),
      }),
    )
    .min(1),
});
type Vectors = z.infer<typeof vectorsSchema>;

const ENDPOINT = "https://vault.example.test/OpenSesame/models/token";

function loadVectors(): Vectors {
  const url = new URL(
    "../../../../../spec/conformance/model-key-exchange-vectors.json",
    import.meta.url,
  );
  return vectorsSchema.parse(JSON.parse(readFileSync(url, "utf8")));
}

const vectors = loadVectors();

async function build() {
  const clock = { now: vectors.now_ms };
  const broker = new ModelKeyBroker(
    {
      now: () => clock.now,
      random: randomString,
      sha256: sha256Base64Url,
      providerForResource: (resource) =>
        vectors.providers.find((p) => p.baseUrl === resource) ?? null,
      connection: (id) => {
        const found = vectors.providers.find((p) => p.connectionId === id);
        return found
          ? { connectionId: id, providerId: found.providerId, verified: true }
          : null;
      },
      audit: () => undefined,
    },
    { ...DEFAULT_POLICY, ...vectors.policy },
  );
  return { clock, broker };
}
type Built = Awaited<ReturnType<typeof build>>;

async function issueRoot(
  harness: Built,
  root: Vectors["cases"][number]["root"],
): Promise<string> {
  const provider = vectors.providers.find((p) => p.baseUrl === root.resource);
  if (!provider) throw new Error(`no provider at ${root.resource}`);
  const draft: ModelGrantDraft = {
    ...root,
    issuerPrincipalId: "person-1",
    organizationId: "org-1",
    connectionId: provider.connectionId,
    dpopJkt: null,
  };
  const digest = await modelGrantDigest(draft, sha256Base64Url);
  const { clock, broker } = harness;
  const issued = await name(draft, async (named) => {
    const verdict = await proveModelGrantApproved(
      named,
      {
        approverPrincipalId: draft.issuerPrincipalId,
        method: "passkey",
        authenticatedAt: clock.now - 10_000,
        approvedAt: clock.now - 1_000,
        boundDigest: digest,
      },
      clock.now,
      sha256Base64Url,
    );
    if (!verdict.ok) throw new Error(`approval refused: ${verdict.code}`);
    return broker.issueRoot(named, verdict.proof);
  });
  return issued.token;
}

/** A key shaped like a real one that this broker never issued. */
const UNKNOWN_KEY = `osk_${"A".repeat(43)}`;

async function refusalOf<Answer>(
  work: () => Promise<Answer>,
): Promise<Refused> {
  try {
    await work();
  } catch (thrown) {
    if (thrown instanceof ModelKeyRefusal)
      return { error: thrown.error, reason: thrown.reason };
    throw thrown;
  }
  return { error: "none", reason: "none" };
}

/** Each member the vector names is, deeply, what the broker answered with; the answer may say more. */
function matches<Answer extends object>(actual: Answer, expected: JsonObject) {
  const answered = new Map(Object.entries(actual));
  for (const [key, value] of Object.entries(expected))
    expect(answered.get(key), key).toEqual(value);
}

type Case = Vectors["cases"][number];
type Step = Case["steps"][number];
type Reservation = Parameters<ModelKeyBroker["settle"]>[0];

/** One case in flight: its broker and clock, the keys it has named, and the calls it has yet to settle. */
type Run = Readonly<{
  built: Built;
  testCase: Case;
  keys: Map<string, string>;
  reservations: Reservation[];
}>;

/** Key order is the order the request parser reads them in, so it is kept. */
function exchangeParams(step: Step, token: string) {
  const entries: [string, string][] = [
    ["grant_type", TOKEN_EXCHANGE_GRANT],
    ["subject_token", token],
    ["subject_token_type", ACCESS_TOKEN_TYPE],
  ];
  if (step.details)
    entries.push([
      "authorization_details",
      JSON.stringify([{ type: "model_access", ...step.details }]),
    ]);
  entries.push(...Object.entries(step.params ?? {}));
  return Object.fromEntries(entries);
}

async function exchange(run: Run, step: Step, token: string): Promise<void> {
  const { broker } = run.built;
  const raw = exchangeParams(step, token);
  const context = { clientId: step.client ?? "app-1", endpoint: ENDPOINT };
  if (step.expect?.refused) {
    expect(await refusalOf(() => broker.exchange(raw, context))).toEqual(
      step.expect.refused,
    );
    return;
  }
  const response = await broker.exchange(raw, context);
  if (step.as) run.keys.set(step.as, response.access_token);
  const { models, ...flat } = step.expect?.issued ?? {};
  matches(response, flat);
  if (models !== undefined)
    expect(response.authorization_details[0]?.models).toEqual(models);
}

function callRequest(run: Run, step: Step) {
  const provider = vectors.providers.find(
    (p) => p.baseUrl === run.testCase.root.resource,
  );
  return {
    operation: step.operation ?? "invoke",
    method: step.method ?? "POST",
    path: step.path ?? "/chat/completions",
    body: step.body,
    resource: step.resource ?? provider?.baseUrl ?? "",
  } as const;
}

async function call(run: Run, step: Step, token: string): Promise<void> {
  const { broker } = run.built;
  const request = callRequest(run, step);
  const presented = { token, clientId: step.client ?? "app-1" };
  if (step.expect?.refused) {
    expect(await refusalOf(() => broker.authorize(presented, request))).toEqual(
      step.expect.refused,
    );
    return;
  }
  const authorized = await broker.authorize(presented, request);
  matches(authorized, step.expect?.allowed ?? {});
  if (step.settle) broker.settle(authorized.reservation, step.settle);
  else run.reservations.push(authorized.reservation);
}

async function revoke(run: Run, token: string): Promise<void> {
  await run.built.broker.revoke({ token });
}

function advance(run: Run, step: Step): void {
  run.built.clock.now += (step.seconds ?? 0) * 1000;
}

/** The key a step presents: the one it names, or the case's root. */
function tokenFor(run: Run, step: Step): string {
  const token = run.keys.get(step.from ?? step.key ?? "root");
  if (token === undefined) throw new Error(`no key ${step.from}`);
  return token;
}

async function play(run: Run, step: Step): Promise<void> {
  if (step.op === "advance") return advance(run, step);
  const token = tokenFor(run, step);
  if (step.op === "revoke") return revoke(run, token);
  if (step.op === "exchange") return exchange(run, step, token);
  return call(run, step, token);
}

async function runCase(testCase: Case): Promise<void> {
  const built = await build();
  const run: Run = {
    built,
    testCase,
    keys: new Map([
      ["root", await issueRoot(built, testCase.root)],
      ["unknown", UNKNOWN_KEY],
    ]),
    reservations: [],
  };
  for (const step of testCase.steps) await play(run, step);
  // A call the case never settled is still in flight: settle it as unsent, as a caller that crashed would.
  for (const reservation of run.reservations)
    built.broker.settle(reservation, { sent: false });
}

describe("model key exchange vectors", () => {
  it("states a case for every refusal reason the broker can give at the exchange and the last hop", () => {
    const reasons = new Set<string>();
    for (const testCase of vectors.cases)
      for (const step of testCase.steps)
        if (step.expect?.refused) reasons.add(step.expect.refused.reason);
    for (const reason of [
      "escalation.resource",
      "escalation.models",
      "escalation.actions",
      "escalation.budget",
      "escalation.budget_remaining",
      "escalation.model",
      "escalation.action",
      "escalation.tokens",
      "depth.exceeded",
      "subject.unknown",
      "subject.inactive",
      "subject.foreign_client",
      "param.unknown",
      "key.inactive",
      "key.foreign_client",
      "aud.mismatch",
      "budget.exhausted",
      "call.route",
      "body.stream",
      "body.tool",
    ])
      expect(reasons.has(reason), reason).toBe(true);
  });

  for (const testCase of vectors.cases)
    it(testCase.name, () => runCase(testCase));
});
