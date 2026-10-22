import { afterEach, describe, expect, it } from "vitest";
import {
  HONEY_TOKEN_KEY,
  honeyTokenId,
  honeyTokenStatus,
  issueHoneyToken,
  listHoneyTokens,
  reconcileHoneyTokenNotices,
  resetHoneyToken,
  revokeHoneyToken,
} from "./honey-tokens.js";
import { kvDelete } from "./kv.js";

afterEach(() => {
  kvDelete(HONEY_TOKEN_KEY);
});

describe("self-managed honey tokens", () => {
  it("issues a synthetic proxy key with the public id encoded once", async () => {
    const token = await issueHoneyToken("work", "CI decoy", 1_700_000_000_000);
    expect(token.token).toMatch(
      /^(?:osr_hny_[0-9a-f]{32}_[0-9a-f]{32}|osr_c0de[0-9a-f]{28})$/u,
    );
    expect(honeyTokenId(token.token)).toBe(token.id);
    expect(honeyTokenStatus(token)).toBe("active");
    expect(listHoneyTokens("work")).toEqual([token]);
    expect(listHoneyTokens("personal")).toEqual([]);
  });

  it("marks the matching id triggered from a critical proxy notice", async () => {
    const token = await issueHoneyToken("work", "CI decoy", 1_000);
    const rows = await reconcileHoneyTokenNotices("work", [
      {
        event: "surrogate.honey_token",
        at: "2026-10-22T10:00:00.000Z",
        subject: token.id,
      },
      {
        event: "surrogate.honey_token",
        at: "2026-10-22T10:00:01.000Z",
        subject: "ffffffffffffffffffffffffffffffff",
      },
    ]);
    expect(rows[0]).toMatchObject({
      id: token.id,
      triggeredAt: Date.parse("2026-10-22T10:00:00.000Z"),
    });
    const [row] = rows;
    if (!row) throw new Error("no row");
    expect(honeyTokenStatus(row)).toBe("triggered");
  });

  it("revokes and resets without changing the id or token", async () => {
    const token = await issueHoneyToken("work", "CI decoy", 1_000);
    const revoked = await revokeHoneyToken("work", token.id, 2_000);
    expect(revoked?.revokedAt).toBe(2_000);
    if (!revoked) throw new Error("not revoked");
    expect(honeyTokenStatus(revoked)).toBe("revoked");
    const reset = await resetHoneyToken("work", token.id);
    expect(reset).toMatchObject({
      id: token.id,
      token: token.token,
      revokedAt: null,
      triggeredAt: null,
    });
  });

  it("shows a use that arrives after revoke instead of hiding it", async () => {
    const token = await issueHoneyToken("work", "CI decoy", 1_000);
    await revokeHoneyToken("work", token.id, 2_000);
    const rows = await reconcileHoneyTokenNotices("work", [
      {
        event: "surrogate.honey_token",
        at: "2026-10-22T10:00:00.000Z",
        subject: token.id,
      },
    ]);
    const [row] = rows;
    if (!row) throw new Error("no row");
    expect(honeyTokenStatus(row)).toBe("triggered");
  });

  it("serializes two quick issues so neither write is lost", async () => {
    await Promise.all([
      issueHoneyToken("work", "one", 1_000),
      issueHoneyToken("work", "two", 1_001),
    ]);
    expect(listHoneyTokens("work")).toHaveLength(2);
  });

  it("rejects near-miss tokens and blank names", async () => {
    for (const value of [
      "osr_hny_short_deadbeef",
      "osr_hny_0123456789abcdef0123456789abcdef_short",
      "osr_0123456789abcdef0123456789abcdef",
    ])
      expect(honeyTokenId(value)).toBeNull();
    await expect(issueHoneyToken("work", "  ")).rejects.toThrow(/name/u);
  });
});
