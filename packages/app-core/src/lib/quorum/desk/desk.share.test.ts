/** @vitest-environment jsdom */
/**
 * An approvals-only circle through the desk, against a real vault tomb and the
 * existing share ledger: ask, collect, wait out the delay, apply, once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localRequestFixture } from "../../local-request.fixture.js";
import { listLocalShares } from "../../local-share-grants.js";
import { lockAllTombs } from "../../vfs.js";
import { Clock, armedCircle, who } from "./harness.test-support.js";
import {
  DEFAULT_TIMING,
  applyAsk,
  approveRequest,
  askStatus,
  askToShare,
  collectApprovals,
  pendingAsks,
  retireCircle,
  takeWelcome,
} from "./index.js";

beforeEach(() => {
  // The share-ledger tests run jsdom with Node's typed arrays; so do these.
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup() {
  const fixture = await localRequestFixture();
  const clock = new Clock();
  const armed = await armedCircle(clock, {
    recovers: false,
    ownerTomb: fixture.tomb,
  });
  const grant = {
    principalId: fixture.personId,
    resourceKind: "item" as const,
    resourceId: "bank-login",
    resourceLabel: "Bank login",
    policy: "read",
    durationSeconds: 3600,
  };
  return { fixture, clock, armed, grant };
}

describe("an approvals-only circle through the desk", () => {
  it("has no shares, so a guardian holds a seat and sends no receipt, and a replayed welcome is refused", async () => {
    const { armed } = await setup();
    expect(armed.dealt.bundleFile).toBeNull();
    for (const welcome of armed.dealt.welcomes) {
      const held = await who(armed, welcome.name).records.held();
      expect(held).toHaveLength(1);
      expect(held[0]?.holding).toBeNull();
      expect(held[0]?.seat.guardianId).toBe(welcome.guardianId);
      await expect(
        takeWelcome(who(armed, welcome.name), welcome.packet),
      ).rejects.toMatchObject({ code: "rollback" });
    }
  });

  it("writes the approved share once, after two of three approve and the delay passes", async () => {
    const { fixture, clock, armed, grant } = await setup();
    const asked = await askToShare(armed.owner, armed.circleId, grant);
    expect(asked.request.summary).toContain('"Bank login"');

    for (const name of ["Ada", "Cy"]) {
      const approval = await approveRequest(who(armed, name), asked.packet);
      const { outcomes } = await collectApprovals(
        armed.owner,
        asked.digest,
        approval,
      );
      expect(outcomes).toEqual([{ ok: true }]);
    }
    // Quorum is met, but the share is not written until the delay has passed.
    await expect(applyAsk(armed.owner, asked.digest)).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(await listLocalShares(fixture.tomb)).toHaveLength(0);

    clock.at(DEFAULT_TIMING.releaseDelaySec + 1);
    expect((await askStatus(armed.owner, asked.digest)).status.state).toBe(
      "authorized",
    );
    const shares = await applyAsk(armed.owner, asked.digest);
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      principalId: grant.principalId,
      resourceLabel: "Bank login",
    });
    expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
    // Once.
    await expect(applyAsk(armed.owner, asked.digest)).rejects.toThrow();
    expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
  });

  it("does not write a share for one approval, or for a guardian approving twice", async () => {
    const { fixture, clock, armed, grant } = await setup();
    const asked = await askToShare(armed.owner, armed.circleId, grant);
    const first = await approveRequest(who(armed, "Ada"), asked.packet);
    await collectApprovals(armed.owner, asked.digest, first);
    const again = await collectApprovals(armed.owner, asked.digest, first);
    expect(again.outcomes[0]).toMatchObject({ ok: false });
    clock.at(DEFAULT_TIMING.releaseDelaySec + 1);
    await expect(applyAsk(armed.owner, asked.digest)).rejects.toThrow();
    expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
  });

  it("lists what is waiting on the circle, and forgets it when the circle is retired", async () => {
    const { armed, grant } = await setup();
    const asked = await askToShare(armed.owner, armed.circleId, grant);
    expect(
      (await pendingAsks(armed.owner, armed.circleId)).map((a) => a.digest),
    ).toEqual([asked.digest]);
    await retireCircle(armed.owner, armed.circleId);
    expect(
      await pendingAsks(armed.owner, armed.circleId).catch(() => []),
    ).toEqual([]);
    expect(await armed.owner.records.owned()).toEqual([]);
  });
});
