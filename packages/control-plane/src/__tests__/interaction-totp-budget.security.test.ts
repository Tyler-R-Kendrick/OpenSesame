import * as schema from "@opensesame/database/schema";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionTotpBudget } from "../routes/interaction-activation-totp.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import { totpCode } from "../routes/mfa-totp.js";
import {
  DEV,
  NOW,
  enrolTotp,
  headers,
  pinClock,
  remove,
  signedIn,
} from "./mfa-step-up-fixture.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";
import { seedOwnedCeremony } from "./seed-ceremony-subject.js";

type Plane = ReturnType<typeof createControlPlane>;
type Actor = Awaited<ReturnType<typeof signedIn>>;
type Pending = { ref: string; activationId: string };

pinClock();
beforeAll(warmMigratedPGlite, 60_000);
beforeEach(() => {
  resetInteractionLinkBudget();
  resetInteractionTotpBudget();
});

let sequence = 0;
async function pending(cp: Plane, actor: Actor): Promise<Pending> {
  const inbox = await cp.app.request("/v1/authorization-requests/inbox-ref", {
    headers: headers(actor.accessToken),
  });
  const approverRef = overlapCast(await inbox.json()).approverRef;
  const subjectId = `totp-budget-${++sequence}`;
  seedOwnedCeremony(cp, "device_authorization", subjectId, actor.principalId);
  const raised = await cp.app.request("/v1/interactions", {
    method: "POST",
    headers: {
      ...headers(actor.accessToken),
      "idempotency-key": subjectId,
    },
    body: JSON.stringify({
      kind: "device_authorization",
      subject: { kind: "device_authorization", subjectId },
      approverRef,
      authorizationDetails: [
        { type: "connection_delegation", actions: ["repository.read"] },
      ],
      ttlSeconds: 300,
    }),
  });
  expect(raised.status).toBe(201);
  const created = overlapCast(await raised.json());
  const begun = await cp.app.request(
    `/v1/interactions/${created.ref}/activation`,
    {
      method: "POST",
      headers: headers(actor.accessToken),
      body: JSON.stringify({
        method: "totp",
        decision: "approved",
        requestDigest: created.requestDigest,
      }),
    },
  );
  expect(begun.status).toBe(201);
  return {
    ref: String(created.ref),
    activationId: String(overlapCast(await begun.json()).activationId),
  };
}

function activate(
  cp: Plane,
  actor: Actor,
  activation: Pending,
  code: string,
  extra: JsonObject = {},
) {
  return cp.app.request(`/v1/interactions/${activation.ref}/activation/totp`, {
    method: "POST",
    headers: headers(actor.accessToken),
    body: JSON.stringify({
      activationId: activation.activationId,
      code,
      ...extra,
    }),
  });
}

function verify(cp: Plane, actor: Actor, code: string) {
  return cp.app.request("/v1/mfa/totp/verify", {
    method: "POST",
    headers: headers(actor.accessToken),
    body: JSON.stringify({ code }),
  });
}

async function fixture() {
  const cp = createControlPlane({ config: DEV });
  const actor = await signedIn(cp);
  const secret = await enrolTotp(cp, actor.accessToken);
  const code = totpCode(secret);
  const wrong = code === "000000" ? "111111" : "000000";
  return { cp, actor, code, wrong, activation: await pending(cp, actor) };
}

describe("one account TOTP budget across every verifier", () => {
  it("cannot switch from ordinary verification or factor removal to activation", async () => {
    const { cp, actor, activation, code, wrong } = await fixture();
    for (let i = 0; i < 2; i++) {
      expect((await verify(cp, actor, wrong)).status).toBe(401);
      expect(
        (
          await remove(cp, actor.accessToken, "totp", {
            kind: "totp",
            code: wrong,
          })
        ).status,
      ).toBe(403);
    }
    expect((await activate(cp, actor, activation, wrong)).status).toBe(401);
    expect((await activate(cp, actor, activation, code)).status).toBe(429);
    expect((await verify(cp, actor, code)).status).toBe(429);
  });

  it("a fresh activation and process-local reset do not replenish guesses", async () => {
    const { cp, actor, activation, code, wrong } = await fixture();
    for (let i = 0; i < 5; i++) {
      expect((await activate(cp, actor, activation, wrong)).status).toBe(401);
    }
    resetInteractionTotpBudget();
    const fresh = await pending(cp, actor);
    expect((await activate(cp, actor, fresh, code)).status).toBe(429);
    expect((await verify(cp, actor, code)).status).toBe(429);
    const other = await signedIn(cp);
    const otherSecret = await enrolTotp(cp, other.accessToken);
    expect(
      (
        await activate(
          cp,
          other,
          await pending(cp, other),
          totpCode(otherSecret),
        )
      ).status,
    ).toBe(200);
  });

  it("parallel activations admit only five account guesses", async () => {
    const { cp, actor, activation, wrong } = await fixture();
    const second = await pending(cp, actor);
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        activate(cp, actor, i % 2 === 0 ? activation : second, wrong),
      ),
    );
    expect(results.filter((result) => result.status === 401)).toHaveLength(5);
    expect(results.filter((result) => result.status === 429)).toHaveLength(11);
  });

  it("success resets failures but the accepted code cannot be replayed anywhere", async () => {
    const { cp, actor, activation, code, wrong } = await fixture();
    expect((await activate(cp, actor, activation, wrong)).status).toBe(401);
    expect((await activate(cp, actor, activation, code)).status).toBe(200);
    expect(
      await cp.ctx.stores.mfaFailures.get(`totp:${actor.principalId}`),
    ).toBeUndefined();
    expect((await verify(cp, actor, code)).status).toBe(401);
    expect(
      (await activate(cp, actor, await pending(cp, actor), code)).status,
    ).toBe(401);
  });

  it("parallel correct codes activate once and expired activations cost no guesses", async () => {
    const { cp, actor, activation, code } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => activate(cp, actor, activation, code)),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(
      results.every((result) => [200, 401, 409, 429].includes(result.status)),
    ).toBe(true);
    const fresh = await pending(cp, actor);
    const count = await cp.ctx.stores.mfaFailures.get(
      `totp:${actor.principalId}`,
    );
    vi.setSystemTime(NOW + 301_000);
    expect((await activate(cp, actor, fresh, code)).status).toBe(410);
    expect(
      await cp.ctx.stores.mfaFailures.get(`totp:${actor.principalId}`),
    ).toBe(count);
  });

  it("never charges malformed or foreign activations and fails closed on storage errors", async () => {
    const { cp, actor, activation, code } = await fixture();
    const foreign = await signedIn(cp);
    expect((await activate(cp, foreign, activation, code)).status).toBe(404);
    expect((await activate(cp, actor, activation, "1234")).status).toBe(400);
    expect(
      await cp.ctx.stores.mfaFailures.get(`totp:${actor.principalId}`),
    ).toBeUndefined();
    const storage = vi
      .spyOn(cp.ctx.stores.mfaFailures, "get")
      .mockImplementation(() => {
        throw new Error("test counter unavailable");
      });
    try {
      expect((await activate(cp, actor, activation, code)).status).toBe(500);
    } finally {
      storage.mockRestore();
    }
    expect((await activate(cp, actor, activation, code)).status).toBe(200);
  });

  it("existing seeds stay fenced when development defaults are switched off", async () => {
    const { cp, actor, activation, code, wrong } = await fixture();
    cp.ctx.config.allowDevDefaults = false;
    expect((await verify(cp, actor, code)).status).toBe(403);
    for (let i = 0; i < 5; i++) {
      expect((await activate(cp, actor, activation, wrong)).status).toBe(401);
    }
    resetInteractionTotpBudget();
    expect(
      (await activate(cp, actor, await pending(cp, actor), code)).status,
    ).toBe(429);
  });

  it("shares the five-guess limit across database-backed replicas and restarts", async () => {
    const client = await migratedPGlite();
    try {
      const database = overlapCast(drizzle(client, { schema }));
      const shared = {
        database,
        config: {
          ...DEV,
          claimPepper: "totp-budget-durable-test-pepper-32-bytes",
        },
      };
      const first = createControlPlane(shared);
      const second = createControlPlane(shared);
      await Promise.all([
        first.ctx.systemPrincipalReady,
        second.ctx.systemPrincipalReady,
      ]);
      const actor = await signedIn(first);
      const code = totpCode(await enrolTotp(first, actor.accessToken));
      const wrong = code === "000000" ? "111111" : "000000";
      const activation = await pending(first, actor);
      const another = await pending(first, actor);
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          activate(
            i % 2 === 0 ? first : second,
            actor,
            i % 2 === 0 ? activation : another,
            wrong,
          ),
        ),
      );
      expect(results.filter((result) => result.status === 401)).toHaveLength(5);
      expect(results.filter((result) => result.status === 429)).toHaveLength(
        11,
      );
      resetInteractionTotpBudget();
      const restarted = createControlPlane(shared);
      await restarted.ctx.systemPrincipalReady;
      expect((await activate(restarted, actor, activation, code)).status).toBe(
        429,
      );
      expect((await verify(restarted, actor, code)).status).toBe(429);
    } finally {
      await client.close();
    }
  }, 60_000);
});
