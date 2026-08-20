import { describe, expect, it } from "vitest";
import { oidcPayloadFromRow, oidcRowValues } from "../src/index.js";
import { overlapCast } from "@opensesame/os-domain";

const now = new Date("2026-08-08T12:00:00.000Z");

describe("oidc payload storage rules", () => {
  it("lifts the lookup keys the provider searches by", () => {
    const row = oidcRowValues(
      "DeviceCode",
      "dc-1",
      { uid: "u-1", userCode: "ABCD-EFGH", grantId: "g-1" },
      null,
    );
    expect(row).toMatchObject({
      uid: "u-1",
      userCode: "ABCD-EFGH",
      grantId: "g-1",
    });

    // A non-string key would be stored as a row nothing could look up again.
    const odd = oidcRowValues(
      "Session",
      "s-1",
      { uid: overlapCast(7) },
      null,
    );
    expect(odd.uid).toBeNull();
    expect(odd.userCode).toBeNull();
    expect(odd.grantId).toBeNull();
  });

  it("does not hand back a record whose TTL has passed", () => {
    const expired = {
      payload: { jti: "t-1" },
      expiresAt: new Date(now.getTime() - 1),
      consumedAt: null,
    };
    expect(oidcPayloadFromRow(expired, now)).toBeUndefined();

    const live = {
      payload: { jti: "t-2" },
      expiresAt: new Date(now.getTime() + 1_000),
      consumedAt: null,
    };
    expect(oidcPayloadFromRow(live, now)).toEqual({ jti: "t-2" });

    // A model with no TTL is not treated as already over.
    expect(
      oidcPayloadFromRow(
        { payload: { kind: "Grant" }, expiresAt: null, consumedAt: null },
        now,
      ),
    ).toEqual({ kind: "Grant" });
  });

  it("returns a consumed code as consumed rather than as absent", () => {
    const consumed = {
      payload: { jti: "code-1" },
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: new Date(now.getTime() - 5_000),
    };
    // The provider decides what a replayed authorization code means; it has to
    // see the stamp to say "already redeemed" instead of "never existed".
    expect(oidcPayloadFromRow(consumed, now)).toEqual({
      jti: "code-1",
      consumed: Math.floor(consumed.consumedAt.getTime() / 1000),
    });
  });

  it("does not mutate the stored payload when stamping it", () => {
    const payload = { jti: "code-2" };
    const read = oidcPayloadFromRow(
      { payload, expiresAt: null, consumedAt: now },
      now,
    );
    expect(read).toHaveProperty("consumed");
    expect(payload).toEqual({ jti: "code-2" });
  });
});
