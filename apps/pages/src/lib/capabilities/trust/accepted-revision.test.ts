import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvSeams } from "../../kv.js";
import {
  ACCEPTED_POLICY_KEY,
  type AcceptedPolicyRecord,
  checkRevision,
  compareRevisions,
  readAcceptedPolicy,
  recordAcceptedPolicy,
} from "./accepted-revision.js";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const accepted: AcceptedPolicyRecord = {
  instanceId: "inst-family",
  revision: "2026-09-22.3",
  digest: D1,
  provenance: "signed-import",
  acceptedAt: "2026-09-22T12:00:00.000Z",
};

const original = { ...kvSeams };
const durable = new Map<string, string>();

describe("accepted revision record (S03)", () => {
  beforeEach(() => {
    durable.clear();
    Object.assign(kvSeams, {
      kvGet: (key: string) => durable.get(key) ?? null,
      kvSetDurable: async (key: string, value: string) => {
        durable.set(key, value);
      },
    });
  });
  afterEach(() => {
    Object.assign(kvSeams, original);
  });

  it("round-trips through the documented key and rejects garbage", async () => {
    expect(readAcceptedPolicy()).toBeNull();
    await recordAcceptedPolicy(accepted);
    expect(durable.has(ACCEPTED_POLICY_KEY)).toBe(true);
    expect(readAcceptedPolicy()).toEqual(accepted);
    durable.set(ACCEPTED_POLICY_KEY, "{not json");
    expect(readAcceptedPolicy()).toBeNull();
    durable.set(ACCEPTED_POLICY_KEY, JSON.stringify({ ...accepted, digest: "md5:x" }));
    expect(readAcceptedPolicy()).toBeNull();
    durable.set(ACCEPTED_POLICY_KEY, JSON.stringify({ ...accepted, provenance: "trusted" }));
    expect(readAcceptedPolicy()).toBeNull();
    await expect(
      recordAcceptedPolicy({ ...accepted, acceptedAt: "not a time" }),
    ).rejects.toThrow();
  });

  it("orders revisions numerically where it can", () => {
    expect(compareRevisions("9", "10")).toBe(-1);
    expect(compareRevisions("2026.09.22-3", "2026.09.22-2")).toBe(1);
    expect(compareRevisions("family-r1", "family-r1")).toBe(0);
    expect(compareRevisions("family-r2", "family-r10")).toBe(-1);
    expect(compareRevisions("a", "a.1")).toBe(-1);
    expect(compareRevisions("b", "a")).toBe(1);
  });

  it("TRUST-05: an older revision is a rollback, including a restored copy", () => {
    expect(checkRevision({ ...accepted, revision: "2026-09-22.2" }, accepted)).toBe("rollback");
    expect(checkRevision({ ...accepted, revision: "2026-09-21.9" }, accepted)).toBe("rollback");
    // Storage restored from a backup carries a record newer than the document
    // the deployment now serves: the candidate is stale, not the record.
    expect(checkRevision({ ...accepted, revision: "2026-09-22.1", digest: D2 }, accepted)).toBe(
      "rollback",
    );
  });

  it("TRUST-06: the same revision with a different digest is a conflict", () => {
    expect(checkRevision({ ...accepted, digest: D2 }, accepted)).toBe("conflict-same-revision");
    expect(checkRevision(accepted, accepted)).toBe("ok");
  });

  it("accepts a newer revision, a first acceptance, and refuses another instance", () => {
    expect(checkRevision({ ...accepted, revision: "2026-09-22.4", digest: D2 }, accepted)).toBe("ok");
    expect(checkRevision(accepted, null)).toBe("ok");
    expect(checkRevision({ ...accepted, instanceId: "inst-other", revision: "99" }, accepted)).toBe(
      "wrong-instance",
    );
  });
});
