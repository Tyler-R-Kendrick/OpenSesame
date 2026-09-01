/**
 * The single-use rule, tested as a race rather than as a sequence.
 *
 * Testing "consume twice in a row returns false the second time" proves
 * almost nothing — any read-then-write implementation passes it. The test that
 * matters fires many consumers at the same session concurrently and asserts
 * exactly one winner, because that is the shape of the attack: post the same
 * response several times at once and hope two of them cross inside the store.
 */

import { describe, expect, it } from "vitest";
import { Openid4vpError } from "./errors.js";
import {
  type AuthorizationRequest,
  buildAuthorizationRequest,
} from "./request.js";
import { InMemoryRequestSessionStore } from "./session.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");

function request(now: Date = NOW, ttlSeconds = 300): AuthorizationRequest {
  return buildAuthorizationRequest({
    clientId: "x509_san_dns:verifier.example",
    responseMode: "direct_post",
    responseUri: "https://verifier.example/openid4vp/response",
    dcqlQuery: {
      credentials: [
        {
          id: "pid",
          format: "dc+sd-jwt",
          vctValues: ["https://credentials.example/pid"],
        },
      ],
    },
    ttlSeconds,
    now,
  });
}

describe("InMemoryRequestSessionStore", () => {
  it("hands the session to exactly one of many concurrent consumers", async () => {
    const store = new InMemoryRequestSessionStore();
    const session = request();
    await store.create(session);

    const outcomes = await Promise.all(
      Array.from({ length: 64 }, () => store.consume(session.state, NOW)),
    );
    expect(outcomes.filter((won) => won)).toHaveLength(1);
  });

  it("keeps a consumed session so a replay is distinguishable from a stranger", async () => {
    const store = new InMemoryRequestSessionStore();
    const session = request();
    await store.create(session);
    await store.consume(session.state, NOW);

    const record = await store.lookup(session.state);
    expect(record?.consumedAt).toEqual(NOW);
    expect(await store.lookup("never-existed")).toBeNull();
  });

  it("refuses to overwrite an existing state", async () => {
    const store = new InMemoryRequestSessionStore();
    const session = request();
    await store.create(session);
    await expect(store.create(session)).rejects.toBeInstanceOf(Openid4vpError);
  });

  it("sweeps expired sessions instead of holding them forever", async () => {
    const store = new InMemoryRequestSessionStore();
    const stale = request(NOW, 60);
    await store.create(stale);
    expect(store.size).toBe(1);

    const later = new Date(NOW.getTime() + 120_000);
    await store.create(request(later));
    expect(store.size).toBe(1);
    expect(await store.lookup(stale.state)).toBeNull();
  });

  it("stays bounded under an unauthenticated flood of new requests", async () => {
    const store = new InMemoryRequestSessionStore({ maxSessions: 8 });
    const created: AuthorizationRequest[] = [];
    for (let index = 0; index < 64; index += 1) {
      const session = request();
      created.push(session);
      await store.create(session);
    }
    expect(store.size).toBe(8);
    // Eviction is oldest-first: the newest sessions are the ones still live.
    const newest = created[created.length - 1];
    if (newest === undefined) throw new Error("nothing created");
    expect(await store.lookup(newest.state)).not.toBeNull();
    const oldest = created[0];
    if (oldest === undefined) throw new Error("nothing created");
    expect(await store.lookup(oldest.state)).toBeNull();
  });

  it("refuses a nonsensical bound rather than silently defaulting", () => {
    expect(() => new InMemoryRequestSessionStore({ maxSessions: 0 })).toThrow(
      Openid4vpError,
    );
  });
});
