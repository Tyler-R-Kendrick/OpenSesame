import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import { isString, overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { DurableJwtReplayCache } from "../repos/durable-jwt-replay.js";
import { DurableMap } from "../repos/durable-map.js";

// Each PGlite test here boots a database and applies every migration inside
// the test itself; on a loaded CI runner that alone took most of the
// package's 15s budget (legacy-agent-durability timed out on it). Same 60s
// budget the beforeAll-based PGlite suites give the identical setup.
vi.setConfig({ testTimeout: 60_000 });

const OPERATOR = "replica-operator-token";
const PEPPER = "replica-test-only-claim-pepper-32chars";

type Plane = ReturnType<typeof createControlPlane>;

let client: PGlite | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function replicaPair() {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: new URL(
      "../../../../packages/database/drizzle",
      import.meta.url,
    ).pathname,
  });
  const options = {
    database: overlapCast(db),
    config: {
      claimPepper: PEPPER,
      operatorToken: OPERATOR,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  };
  const first = createControlPlane(options);
  const second = createControlPlane(options);
  await Promise.all([
    first.ctx.systemPrincipalReady,
    second.ctx.systemPrincipalReady,
  ]);
  return { db, options, first, second };
}

async function mintTicket(plane: Plane) {
  const res = await plane.app.request("/v1/enrollment/tickets", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPERATOR}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ttlSeconds: 120 }),
  });
  expect(res.status).toBe(201);
  const body = overlapCast(await res.json());
  if (!isString(body.ticket) || !isString(body.id)) {
    throw new Error("mint did not return a ticket");
  }
  return { ticket: body.ticket, id: body.id };
}

function bootstrap(plane: Plane, ticket: string, slug: string) {
  return plane.app.request("/v1/enrollment/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticket,
      organization: { slug, displayName: "First admin org" },
    }),
  });
}

// Every test here stands up two control-plane instances on an in-process
// PGlite and runs the migrations against it. That is about 1.5s each on a
// warm local checkout and several times that on a loaded shared runner, so
// these carry a budget that fits the work rather than the 5s default.
describe("ADV-30 first-admin enrollment", { timeout: 60_000 }, () => {
  it("mints only for the operator and refuses a public first-user-wins", async () => {
    const { first } = await replicaPair();
    const unauth = await first.app.request("/v1/enrollment/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unauth.status).toBe(401);
    const missing = await first.app.request("/v1/enrollment/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organization: { slug: "no-ticket", displayName: "Nope" },
      }),
    });
    expect(missing.status).toBe(400);
    const garbage = await bootstrap(first, "not-a-ticket", "garbage-org");
    expect(garbage.status).toBe(401);
  });

  it("lets exactly one of two racing browsers consume a ticket", async () => {
    const { first, second } = await replicaPair();
    const { ticket } = await mintTicket(first);
    const raced = await Promise.all([
      bootstrap(first, ticket, "race-org"),
      bootstrap(second, ticket, "race-org"),
    ]);
    const statuses = raced.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 401]);
    const winner = raced.find((res) => res.status === 201);
    const body = overlapCast(await winner?.json());
    expect(body.assurance).toBe("verified");
    expect(body.organization).toMatchObject({
      slug: "race-org",
      role: "owner",
    });
    const replay = await bootstrap(first, ticket, "other-org");
    expect(replay.status).toBe(401);
  });

  it("refuses a spent ticket after a replica restart", async () => {
    const { first, options } = await replicaPair();
    const { ticket } = await mintTicket(first);
    expect((await bootstrap(first, ticket, "restart-org")).status).toBe(201);
    const restarted = createControlPlane(options);
    await restarted.ctx.systemPrincipalReady;
    expect((await bootstrap(restarted, ticket, "restart-org-2")).status).toBe(
      401,
    );
  });
});

describe("ADV-18 durable jwt replay", { timeout: 60_000 }, () => {
  it("shares private_key_jwt jti consumption across maps on one database", async () => {
    const { db } = await replicaPair();
    const first = new DurableJwtReplayCache(
      new DurableMap(
        overlapCast(db),
        "OpenSesame:JwtReplay",
        false,
        86_400_000,
      ),
    );
    const second = new DurableJwtReplayCache(
      new DurableMap(
        overlapCast(db),
        "OpenSesame:JwtReplay",
        false,
        86_400_000,
      ),
    );
    const exp = Date.now() + 60_000;
    expect(await first.remember("iss-a", "jti-1", exp)).toBe(true);
    expect(await second.remember("iss-a", "jti-1", exp)).toBe(false);
    const restarted = new DurableJwtReplayCache(
      new DurableMap(
        overlapCast(db),
        "OpenSesame:JwtReplay",
        false,
        86_400_000,
      ),
    );
    expect(await restarted.remember("iss-a", "jti-1", exp)).toBe(false);
  });
});
