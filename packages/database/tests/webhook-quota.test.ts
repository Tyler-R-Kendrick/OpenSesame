import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemoryRepositories,
  type Repositories,
  WebhookEndpointLimitError,
} from "../src/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let pg: PgTestContext;
beforeAll(async () => {
  pg = await createPgTestContext();
}, 60_000);
afterAll(async () => {
  await pg.client.close();
});
const engines = [
  { name: "memory", repos: (): Repositories => new MemoryRepositories() },
  { name: "postgres", repos: (): Repositories => pg.repos },
];
describe.each(engines)("$name webhook quota", ({ repos: getRepos }) => {
  it("atomically caps concurrent registrations and frees deleted capacity", async () => {
    const repos = getRepos();
    const owner = await repos.principals.create(makePrincipal());
    const create = () =>
      repos.webhookEndpoints.create({
        id: `whep_${randomUUID()}`,
        principalId: owner.id,
        url: "https://hooks.example.test",
        secret: "whsec_test",
        createdAt: new Date(),
      });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 24 }, create),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(10);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected")
        expect(outcome.reason).toBeInstanceOf(WebhookEndpointLimitError);
    }
    const rows = await repos.webhookEndpoints.listForPrincipal(owner.id);
    expect(rows).toHaveLength(10);
    const first = rows[0];
    if (!first) throw new Error("Missing registered endpoint");
    await repos.webhookEndpoints.deleteById(first.id);
    await expect(create()).resolves.toMatchObject({ principalId: owner.id });
  });
  it("rolls back an over-capacity transaction before applying any writes", async () => {
    const repos = getRepos();
    const owner = await repos.principals.create(makePrincipal());
    await expect(
      repos.transaction(async (uow) => {
        for (let index = 0; index < 11; index += 1) {
          await repos.webhookEndpoints.create(
            {
              id: `whep_${randomUUID()}`,
              principalId: owner.id,
              url: "https://hooks.example.test",
              secret: "whsec_test",
              createdAt: new Date(),
            },
            uow,
          );
        }
      }),
    ).rejects.toBeInstanceOf(WebhookEndpointLimitError);
    expect(
      await repos.webhookEndpoints.listForPrincipal(owner.id),
    ).toHaveLength(0);
  });
  it("rejects a competing transaction without partially applying it", async () => {
    if (!(getRepos() instanceof MemoryRepositories)) return;
    const repos = new MemoryRepositories();
    const owner = await repos.principals.create(makePrincipal());
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staged = 0;
    const transaction = () =>
      repos.transaction(async (uow) => {
        for (let index = 0; index < 6; index += 1) {
          await repos.webhookEndpoints.create(
            {
              id: `whep_${randomUUID()}`,
              principalId: owner.id,
              url: "https://hooks.example.test",
              secret: "whsec_test",
              createdAt: new Date(),
            },
            uow,
          );
        }
        staged += 1;
        if (staged === 2) release();
        await ready;
      });
    const outcomes = await Promise.allSettled([transaction(), transaction()]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await repos.webhookEndpoints.listForPrincipal(owner.id),
    ).toHaveLength(6);
  });
});
