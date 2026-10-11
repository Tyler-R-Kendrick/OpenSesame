/**
 * Properties, not examples: whatever sequence of exchanges, calls, revocations
 * and delays is thrown at the broker, no key ever holds more than the key it
 * came from, and nothing is spent twice. (That no input, however malformed,
 * ends in anything but a typed refusal is `property.hostile.test.ts`.)
 */
import {
  type JsonObject,
  parseResourceScope,
  resourcesAttenuate,
  scopeMatches,
} from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ModelKeyRefusal } from "./errors.js";
import {
  OPENAI,
  type Signer,
  harness,
  newSigner,
} from "./harness.test-support.js";
import {
  type CallOp,
  type ExchangeOp,
  type Op,
  ROOT_BUDGET,
  type RevokeOp,
  type SettleOp,
  type WaitOp,
  scenario,
} from "./property.test-support.js";
import type { KeyView } from "./types.js";

const stats = { exchanges: 0, calls: 0, refused: 0 };

type Harness = ReturnType<typeof harness>;
type Reservation = Parameters<Harness["broker"]["settle"]>[0];
type Authorized = Awaited<ReturnType<Harness["call"]>>;
type World = Readonly<{
  h: Harness;
  signer: Signer;
  tokens: string[];
  reservations: Reservation[];
}>;

/** A fresh broker holding one root key, issued to a signer, over `rootModels`. */
async function startWorld(rootModels: string[]): Promise<World> {
  const h = harness();
  const signer = await newSigner();
  const root = await h.root(signer, {
    models: rootModels,
    budget: ROOT_BUDGET,
    lifetimeSeconds: 6 * 3600,
  });
  return { h, signer, tokens: [root.token], reservations: [] };
}

/** The nth key the run has seen, wrapping, as a step names it. */
const tokenAt = (world: World, index: number) =>
  world.tokens[index % world.tokens.length];

function exchangeDetails(step: ExchangeOp): JsonObject {
  const details: JsonObject = { locations: [OPENAI.baseUrl] };
  if (step.models) details.models = step.models;
  if (step.actions) details.actions = step.actions;
  if (step.budget) details.budget = step.budget;
  if (step.lifetime) details.lifetime_seconds = step.lifetime;
  return details;
}

async function exchange(world: World, step: ExchangeOp): Promise<void> {
  const from = tokenAt(world, step.from);
  if (!from) return;
  const { h, signer } = world;
  const issued = await h.exchange(from, exchangeDetails(step), { signer });
  world.tokens.push(issued.access_token);
  stats.exchanges += 1;
}

/** What was authorized is inside what the key holds. */
function expectInsideKey(h: Harness, authorized: Authorized): void {
  const view = h.broker.list().find((row) => row.id === authorized.keyId);
  expect(view).toBeDefined();
  expect(authorized.url.startsWith(`${OPENAI.baseUrl}/`)).toBe(true);
  if (authorized.model === null) return;
  expect(
    view?.models.some((selector) =>
      scopeMatches(
        parseResourceScope(selector),
        `model:openai/${authorized.model}`,
      ),
    ),
  ).toBe(true);
  expect(authorized.outputTokens ?? 0).toBeLessThanOrEqual(
    view?.maxOutputTokens ?? 0,
  );
}

async function call(world: World, step: CallOp): Promise<void> {
  const key = tokenAt(world, step.key);
  if (!key) return;
  const { h, signer } = world;
  const authorized = step.list
    ? await h.call(key, signer, { operation: "list" })
    : await h.call(key, signer, {
        body: h.chat({ model: step.model, max_tokens: step.maxTokens }),
      });
  world.reservations.push(authorized.reservation);
  stats.calls += 1;
  expectInsideKey(h, authorized);
}

function settle(world: World, step: SettleOp): void {
  const slot = step.slot % Math.max(1, world.reservations.length);
  const held = world.reservations[slot];
  if (held)
    world.h.broker.settle(held, {
      sent: step.sent,
      answer: { usage: { prompt_tokens: 1, completion_tokens: 1 } },
    });
}

async function revoke(world: World, step: RevokeOp): Promise<void> {
  const key = tokenAt(world, step.key);
  if (key) await world.h.broker.revoke({ token: key });
}

function wait(world: World, step: WaitOp): void {
  world.h.clock.now += step.seconds * 1000;
}

/** One operation, run for what it does; the invariants are checked around it, not in it. */
async function apply(world: World, step: Op): Promise<void> {
  switch (step.kind) {
    case "exchange":
      return exchange(world, step);
    case "call":
      return call(world, step);
    case "settle":
      return settle(world, step);
    case "revoke":
      return revoke(world, step);
    case "wait":
      return wait(world, step);
  }
}

/** A key may be narrower than its parent in every way, and wider in none. */
function expectAttenuated(view: KeyView, parent: KeyView): void {
  expect(view.depth).toBe(parent.depth + 1);
  expect(view.actions.every((action) => parent.actions.includes(action))).toBe(
    true,
  );
  expect(resourcesAttenuate(view.models, parent.models)).toBe(true);
  expect(view.expiresAt).toBeLessThanOrEqual(parent.expiresAt);
  expect(view.maxOutputTokens).toBeLessThanOrEqual(parent.maxOutputTokens);
  expect(view.clientId).toBe(parent.clientId);
  expect(view.connectionId).toBe(parent.connectionId);
  expect(view.providerId).toBe(parent.providerId);
}

/** Every key, and every key it was derived from, back to `root`. */
function treeOf(
  root: KeyView,
  views: readonly KeyView[],
  byId: ReadonlyMap<string, KeyView>,
): KeyView[] {
  return views.filter((view) => {
    let current: KeyView | undefined = view;
    while (current) {
      if (current.id === root.id) return true;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  });
}

/** What a whole tree of live keys still holds is never more than its root was given. */
function expectConserved(
  views: readonly KeyView[],
  byId: ReadonlyMap<string, KeyView>,
): void {
  for (const root of views.filter(
    (view) => view.parentId === null && view.status === "active",
  )) {
    const live = treeOf(root, views, byId).filter(
      (view) => view.status === "active",
    );
    const held = (key: "requests" | "input_tokens" | "output_tokens") =>
      live.reduce((sum, view) => sum + view.remaining[key], 0);
    expect(held("requests")).toBeLessThanOrEqual(ROOT_BUDGET.requests);
    expect(held("input_tokens")).toBeLessThanOrEqual(ROOT_BUDGET.input_tokens);
    expect(held("output_tokens")).toBeLessThanOrEqual(
      ROOT_BUDGET.output_tokens,
    );
  }
}

function checkChain(views: readonly KeyView[]): void {
  const byId = new Map(views.map((view) => [view.id, view]));
  for (const view of views) {
    expect(view.remaining.requests).toBeGreaterThanOrEqual(0);
    expect(view.remaining.input_tokens).toBeGreaterThanOrEqual(0);
    expect(view.remaining.output_tokens).toBeGreaterThanOrEqual(0);
    expect(view.depth).toBeLessThanOrEqual(2);
    const parent = view.parentId ? byId.get(view.parentId) : undefined;
    if (parent) expectAttenuated(view, parent); // a root, or one whose parent was purged, has nothing to compare with
  }
  expectConserved(views, byId);
}

/** Run one step; a refusal is an answer, and a refused exchange must not have changed anything. */
async function play(world: World, step: Op): Promise<void> {
  const before = JSON.stringify(world.h.broker.list());
  try {
    await apply(world, step);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelKeyRefusal);
    stats.refused += 1;
    if (step.kind === "exchange")
      expect(JSON.stringify(world.h.broker.list())).toBe(before);
  }
  checkChain(world.h.broker.list());
}

describe("a key is never wider than the key it came from", () => {
  it("holds through any sequence of exchanges, calls, settlements, revocations and delays", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ([rootModels, ops]) => {
        const world = await startWorld(rootModels);
        for (const step of ops) await play(world, step);
      }),
      { numRuns: 60 },
    );
    // the property is only worth something if the runs reached the interesting paths
    expect(stats.exchanges).toBeGreaterThan(30);
    expect(stats.calls).toBeGreaterThan(30);
    expect(stats.refused).toBeGreaterThan(30);
  }, 60_000);
});
