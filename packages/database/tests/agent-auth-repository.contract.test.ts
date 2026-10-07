import { randomBytes, randomUUID } from "node:crypto";
import type {
  AgentAccessTokenRecord,
  AgentClaimAttempt,
  AgentRegistration,
} from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Repositories } from "../src/repos/interfaces.js";
import { MemoryRepositories } from "../src/repos/memory.js";
import { makePrincipal } from "./factories.js";
import { createPgTestContext } from "./pg-harness-full.js";

const now = new Date("2026-10-07T00:00:00Z");
const future = new Date(now.getTime() + 60_000);

describe.each(["memory", "postgres"])(
  "%s agent authority persistence",
  (name) => {
    let repos: Repositories;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (name === "memory") {
        repos = new MemoryRepositories();
        close = async () => {};
      } else {
        const pg = await createPgTestContext();
        repos = pg.repos;
        close = () => pg.client.close();
      }
    });
    afterAll(async () => close());

    async function registration(overrides: Partial<AgentRegistration> = {}) {
      const owner = makePrincipal();
      await repos.principals.create(owner);
      return repos.agentAuth.createRegistration({
        id: `areg_${randomUUID()}`,
        kind: "anonymous",
        status: "unclaimed",
        principalId: owner.id,
        createdAt: now,
        expiresAt: future,
        preClaimScopes: ["resource:read"],
        postClaimScopes: ["claim:create"],
        claimTokenDigest: randomBytes(32),
        assertionVersion: 1,
        version: 1,
        ...overrides,
      });
    }

    function access(
      row: AgentRegistration,
      claimed = false,
    ): AgentAccessTokenRecord {
      return {
        id: `aat_${randomUUID()}`,
        registrationId: row.id,
        tokenDigest: randomBytes(32),
        scopes: ["resource:read"],
        claimed,
        assertionVersion: row.assertionVersion,
        resource: "urn:resource:one",
        createdAt: now,
        expiresAt: future,
      };
    }

    it("isolates returned credential material and refuses duplicate registration digests", async () => {
      const row = await registration();
      const digest = row.claimTokenDigest;
      if (!digest) throw new Error("Missing claim digest");
      const found =
        await repos.agentAuth.getRegistrationByClaimTokenDigest(digest);
      expect(found?.id).toBe(row.id);
      found?.preClaimScopes.push("forged:write");
      const refreshed = await repos.agentAuth.getRegistrationById(row.id);
      expect(refreshed?.preClaimScopes).toEqual(["resource:read"]);
      await expect(
        registration({ claimTokenDigest: digest }),
      ).rejects.toThrow();
      await expect(repos.agentAuth.createRegistration(row)).rejects.toThrow();
      expect(await repos.agentAuth.getRegistrationById("absent")).toBeNull();
      expect(
        await repos.agentAuth.getRegistrationByClaimTokenDigest(
          randomBytes(32),
        ),
      ).toBeNull();
    });

    it("admits one concurrent CAS owner transition and rolls back an aborted transaction", async () => {
      const row = await registration();
      const outcomes = await Promise.allSettled(
        ["claimed", "revoked"].map((status) =>
          repos.transaction((uow) =>
            repos.agentAuth.compareAndSetRegistration(
              row.version,
              { ...row, status: status === "claimed" ? "claimed" : "revoked" },
              uow,
            ),
          ),
        ),
      );
      expect(
        outcomes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const current = await repos.agentAuth.getRegistrationById(row.id);
      expect(current?.version).toBe(2);
      if (!current) throw new Error("Missing registration");
      await expect(
        repos.transaction(async (uow) => {
          await repos.agentAuth.compareAndSetRegistration(
            current.version,
            { ...current, status: "expired" },
            uow,
          );
          throw new Error("abort before commit");
        }),
      ).rejects.toThrow("abort before commit");
      expect(await repos.agentAuth.getRegistrationById(row.id)).toEqual(
        current,
      );
      await expect(
        repos.agentAuth.compareAndSetRegistration(1, row),
      ).rejects.toThrow();
    });

    it("expires only due provisional generations and preserves claimed authority metadata", async () => {
      const baseline = await repos.agentAuth.countLiveRegistrations();
      const due = await registration({ expiresAt: now });
      const pending = await registration({
        expiresAt: now,
        status: "claim_pending",
      });
      const claimed = await registration({ expiresAt: now, status: "claimed" });
      await registration();
      expect(await repos.agentAuth.countLiveRegistrations()).toBe(baseline + 3);
      expect(await repos.agentAuth.expireDue(now)).toBe(2);
      expect(await repos.agentAuth.getRegistrationById(due.id)).toMatchObject({
        status: "expired",
        version: 2,
      });
      expect(
        await repos.agentAuth.getRegistrationById(pending.id),
      ).toMatchObject({ status: "expired", version: 2 });
      expect(
        await repos.agentAuth.getRegistrationById(claimed.id),
      ).toMatchObject({ status: "claimed", version: 1 });
      expect(await repos.agentAuth.expireDue(now)).toBe(0);
    });

    it("keeps claim attempts isolated, ordered, and transactional", async () => {
      const row = await registration();
      const other = await registration();
      const first: AgentClaimAttempt = {
        id: randomUUID(),
        registrationId: row.id,
        attemptTokenDigest: new Uint8Array(randomBytes(32)),
        userCodeDigest: new Uint8Array(randomBytes(32)),
        createdAt: now,
        expiresAt: future,
        intervalSeconds: 5,
        pollCount: 0,
        failedAttempts: 0,
        emailNormalized: "owner@example.test",
      };
      await repos.agentAuth.createClaimAttempt(first);
      const latest = {
        ...first,
        id: randomUUID(),
        attemptTokenDigest: new Uint8Array(randomBytes(32)),
        createdAt: new Date(now.getTime() + 1),
      };
      await repos.agentAuth.createClaimAttempt(latest);
      expect((await repos.agentAuth.latestClaimAttempt(row.id))?.id).toBe(
        latest.id,
      );
      expect(await repos.agentAuth.latestClaimAttempt(other.id)).toBeNull();
      expect(
        (
          await repos.agentAuth.getClaimAttemptByTokenDigest(
            first.attemptTokenDigest,
          )
        )?.id,
      ).toBe(first.id);
      const completed = {
        ...latest,
        completedAt: now,
        pollCount: 2,
        failedAttempts: 1,
        slowdownUntil: future,
      };
      await repos.transaction((uow) =>
        repos.agentAuth.updateClaimAttempt(completed, uow),
      );
      expect(
        await repos.agentAuth.getClaimAttemptById(latest.id),
      ).toMatchObject(completed);
      await expect(
        repos.agentAuth.createClaimAttempt({ ...first, id: randomUUID() }),
      ).rejects.toThrow();
      await expect(
        repos.agentAuth.updateClaimAttempt({ ...first, id: "absent" }),
      ).rejects.toThrow();
      expect(await repos.agentAuth.getClaimAttemptById("absent")).toBeNull();
      expect(
        await repos.agentAuth.getClaimAttemptByTokenDigest(randomBytes(32)),
      ).toBeNull();
    });

    it("revokes only the selected registration and frozen claim generation", async () => {
      const row = await registration();
      const other = await registration();
      const unclaimed = access(row);
      const claimed = access(row, true);
      const foreign = access(other);
      for (const token of [unclaimed, claimed, foreign])
        await repos.agentAuth.createAccessToken(token);
      await expect(
        repos.agentAuth.createAccessToken({ ...unclaimed, id: randomUUID() }),
      ).rejects.toThrow();
      expect(
        await repos.agentAuth.revokeAccessTokensForRegistration(
          row.id,
          now,
          true,
        ),
      ).toBe(1);
      expect(
        await repos.agentAuth.getAccessTokenByDigest(unclaimed.tokenDigest),
      ).toMatchObject({ revokedAt: now });
      expect(
        (await repos.agentAuth.getAccessTokenByDigest(claimed.tokenDigest))
          ?.revokedAt,
      ).toBeUndefined();
      expect(
        (await repos.agentAuth.getAccessTokenByDigest(foreign.tokenDigest))
          ?.revokedAt,
      ).toBeUndefined();
      expect(
        await repos.agentAuth.revokeAccessTokensForRegistration(
          row.id,
          future,
          false,
        ),
      ).toBe(1);
      await repos.agentAuth.revokeAccessToken(claimed.id, future);
      await repos.agentAuth.revokeAccessToken("absent", future);
      await repos.agentAuth.revokeAccessToken(foreign.id, future);
      expect(
        (await repos.agentAuth.getAccessTokenByDigest(foreign.tokenDigest))
          ?.revokedAt,
      ).toEqual(future);
      expect(
        (await repos.agentAuth.getAccessTokenByDigest(unclaimed.tokenDigest))
          ?.revokedAt,
      ).toEqual(now);
      expect(
        await repos.agentAuth.getAccessTokenByDigest(randomBytes(32)),
      ).toBeNull();
    });

    it("retires assertion generations without touching current or foreign issuances", async () => {
      const row = await registration();
      const other = await registration();
      const records = [
        {
          jti: randomUUID(),
          registrationId: row.id,
          assertionVersion: 1,
          createdAt: now,
          expiresAt: future,
        },
        {
          jti: randomUUID(),
          registrationId: row.id,
          assertionVersion: 2,
          createdAt: now,
          expiresAt: future,
        },
        {
          jti: randomUUID(),
          registrationId: other.id,
          assertionVersion: 1,
          createdAt: now,
          expiresAt: future,
        },
      ];
      for (const record of records)
        await repos.agentAuth.createAssertion(record);
      const [old, current, foreign] = records;
      if (!old || !current || !foreign)
        throw new Error("Missing assertion fixtures");
      await expect(repos.agentAuth.createAssertion(old)).rejects.toThrow();
      expect(
        await repos.agentAuth.revokeAssertionsForRegistration(row.id, now, 2),
      ).toBe(1);
      expect(await repos.agentAuth.getAssertionByJti(old.jti)).toMatchObject({
        revokedAt: now,
      });
      expect(
        (await repos.agentAuth.getAssertionByJti(current.jti))?.revokedAt,
      ).toBeUndefined();
      expect(
        (await repos.agentAuth.getAssertionByJti(foreign.jti))?.revokedAt,
      ).toBeUndefined();
      expect(
        await repos.agentAuth.revokeAssertionsForRegistration(row.id, future),
      ).toBe(1);
      expect(
        await repos.agentAuth.revokeAssertionsForRegistration(row.id, future),
      ).toBe(0);
      expect(await repos.agentAuth.getAssertionByJti("absent")).toBeNull();
    });

    it("scopes provider replay evidence to issuer and rolls back an aborted consumption", async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      const jti = randomUUID();
      expect(
        await repos.agentAuth.consumeProviderAssertionReplay(
          "issuer-one",
          jti,
          expiresAt,
        ),
      ).toBe(true);
      expect(
        await repos.agentAuth.consumeProviderAssertionReplay(
          "issuer-one",
          jti,
          expiresAt,
        ),
      ).toBe(false);
      expect(
        await repos.agentAuth.consumeProviderAssertionReplay(
          "issuer-two",
          jti,
          expiresAt,
        ),
      ).toBe(true);
      const aborted = randomUUID();
      await expect(
        repos.transaction(async (uow) => {
          expect(
            await repos.agentAuth.consumeProviderAssertionReplay(
              "issuer-one",
              aborted,
              expiresAt,
              uow,
            ),
          ).toBe(true);
          throw new Error("abort replay consumption");
        }),
      ).rejects.toThrow("abort replay consumption");
      expect(
        await repos.agentAuth.consumeProviderAssertionReplay(
          "issuer-one",
          aborted,
          expiresAt,
        ),
      ).toBe(true);
      expect(
        await repos.agentAuth.consumeProviderAssertionReplay(
          "issuer-one",
          aborted,
          expiresAt,
        ),
      ).toBe(false);
    });
  },
);
