import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  MemoryRepositories,
  type Repositories,
} from "../src/index.js";
import { makePrincipal, makePushSubscription } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

/**
 * A push endpoint is a capability URL, so the row's owner is part of what it
 * protects. The same contract runs against the in-memory repository and the
 * Postgres one (PGlite, or the real server named by DATABASE_URL): a
 * registration for an endpoint a live row already holds must never move it.
 */

let pg: PgTestContext;

beforeAll(async () => {
  pg = await createPgTestContext();
}, 60_000);

afterAll(async () => {
  await pg.client.close();
});

type Engine = {
  name: string;
  repos: () => Repositories;
};

const engines: Engine[] = [
  { name: "MemoryRepositories", repos: () => new MemoryRepositories() },
  { name: "PostgresRepositories", repos: () => pg.repos },
];

describe.each(engines)("$name.pushSubscriptions ownership", (engine) => {
  async function twoPrincipals() {
    const repos = engine.repos();
    const owner = (await repos.principals.create(makePrincipal())).id;
    const other = (await repos.principals.create(makePrincipal())).id;
    return { repos, owner, other };
  }

  it("adversarial: another principal presenting a live endpoint cannot take it over", async () => {
    const { repos, owner, other } = await twoPrincipals();
    const endpointDigest = `sha256:${randomUUID()}`;
    const owned = await repos.pushSubscriptions.create(
      makePushSubscription(owner, {
        endpointDigest,
        deviceLabel: "owner's phone",
      }),
    );

    await expect(
      repos.pushSubscriptions.create(
        makePushSubscription(other, {
          endpointDigest,
          deviceLabel: "thief's phone",
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Nothing moved: same owner, same keys, same label, and still the owner's
    // destination and nobody else's.
    const after = await repos.pushSubscriptions.getById(owned.id);
    expect(after?.principalId).toBe(owner);
    expect(after?.deviceLabel).toBe("owner's phone");
    expect(after?.authSecret).toBe(owned.authSecret);
    expect(
      (await repos.pushSubscriptions.listForPrincipal(owner)).map(
        (row) => row.id,
      ),
    ).toEqual([owned.id]);
    expect(await repos.pushSubscriptions.listForPrincipal(other)).toEqual([]);
    // The owner can still retire it: it was never reassigned.
    expect(await repos.pushSubscriptions.disable(owned.id, new Date())).toBe(
      true,
    );
  });

  it("contract: the owner re-registering keeps the row and replaces its keys", async () => {
    const { repos, owner } = await twoPrincipals();
    const endpointDigest = `sha256:${randomUUID()}`;
    const first = await repos.pushSubscriptions.create(
      makePushSubscription(owner, { endpointDigest }),
    );
    const again = await repos.pushSubscriptions.create(
      makePushSubscription(owner, { endpointDigest }),
    );
    expect(again.id).toBe(first.id);
    expect(again.authSecret).not.toBe(first.authSecret);
  });

  it("adversarial: disabling on behalf of a principal cannot retire a row that changed hands", async () => {
    const { repos, owner, other } = await twoPrincipals();
    const endpointDigest = `sha256:${randomUUID()}`;
    const first = await repos.pushSubscriptions.create(
      makePushSubscription(owner, { endpointDigest }),
    );
    // The owner's request checked ownership, then lost the race: the endpoint
    // was freed and re-registered by `other` before the owner's disable ran.
    await repos.pushSubscriptions.disable(first.id, new Date(), owner);
    await repos.pushSubscriptions.create(
      makePushSubscription(other, { endpointDigest }),
    );

    expect(
      await repos.pushSubscriptions.disable(first.id, new Date(), owner),
    ).toBe(false);
    expect(
      (await repos.pushSubscriptions.getById(first.id))?.disabledAt,
    ).toBeUndefined();
    expect(
      (await repos.pushSubscriptions.listForPrincipal(other)).map((r) => r.id),
    ).toEqual([first.id]);
    // A system retirement (no principal) and the real owner still work.
    expect(
      await repos.pushSubscriptions.disable(first.id, new Date(), other),
    ).toBe(true);
  });

  it("contract: a row its owner disabled may be registered by someone else", async () => {
    const { repos, owner, other } = await twoPrincipals();
    const endpointDigest = `sha256:${randomUUID()}`;
    const first = await repos.pushSubscriptions.create(
      makePushSubscription(owner, { endpointDigest }),
    );
    await repos.pushSubscriptions.disable(first.id, new Date());

    // The same browser, signed in as someone else after the first signed out.
    const second = await repos.pushSubscriptions.create(
      makePushSubscription(other, { endpointDigest }),
    );
    expect(second.id).toBe(first.id);
    expect(second.principalId).toBe(other);
    expect(second.disabledAt).toBeUndefined();
    expect(await repos.pushSubscriptions.listForPrincipal(owner)).toEqual([]);
    expect(
      (await repos.pushSubscriptions.listForPrincipal(other)).map(
        (row) => row.id,
      ),
    ).toEqual([first.id]);
  });
});
