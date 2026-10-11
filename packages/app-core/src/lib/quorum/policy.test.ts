/**
 * The policy: what is refused outright, what is only warned about, what
 * satisfies it, and who may sign it.
 */
import { describe, expect, it } from "vitest";
import { toB64url } from "./bytes.js";
import { canonicalize, digestBytes, frame, framedDigest } from "./canonical.js";
import {
  PolicyError,
  assertPolicySound,
  policyDigest,
  policyWarnings,
  satisfies,
  signPolicy,
  verifySignedPolicy,
} from "./policy.js";
import type { CirclePolicy, Guardian } from "./types.js";
import { buildWorld, person } from "./world.test-support.js";

const NAMES = ["Ada", "Ben", "Cy", "Dee", "Eli"] as const;

async function base() {
  const world = await buildWorld({
    names: NAMES,
    groups: [{ id: "all", threshold: 3, members: NAMES }],
    skipDelivery: true,
  });
  return { world, policy: world.created.signedPolicy.policy };
}

function with_(
  policy: CirclePolicy,
  over: Partial<CirclePolicy>,
): CirclePolicy {
  return { ...policy, ...over };
}

function code(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyError) return error.code;
    throw error;
  }
  return "accepted";
}

describe("a sound policy", () => {
  it("passes, and carries a commitment for every guardian and no one else", async () => {
    const { policy } = await base();
    expect(() => assertPolicySound(policy)).not.toThrow();
    expect(Object.keys(policy.shareCommitments).sort()).toEqual(
      policy.guardians.map((g) => g.id).sort(),
    );
  });
});

describe("what a policy refuses", () => {
  it("a guardian in no group, in two groups, or twice", async () => {
    const { policy } = await base();
    const ids = policy.guardians.map((g) => g.id);
    expect(
      code(() =>
        assertPolicySound(
          with_(policy, {
            groups: [{ id: "g", threshold: 2, guardianIds: ids.slice(0, 4) }],
          }),
        ),
      ),
    ).toBe("group_membership");
    expect(
      code(() =>
        assertPolicySound(
          with_(policy, {
            groupThreshold: 1,
            groups: [
              { id: "a", threshold: 2, guardianIds: ids.slice(0, 3) },
              { id: "b", threshold: 2, guardianIds: ids.slice(2) },
            ],
          }),
        ),
      ),
    ).toBe("guardian_in_two_groups");
    const dup: Guardian[] = [
      ...policy.guardians,
      ...policy.guardians.slice(0, 1),
    ];
    expect(
      code(() => assertPolicySound(with_(policy, { guardians: dup }))),
    ).toBe("duplicate_guardian");
  });

  it("thresholds above their counts, and a 1-of-N group", async () => {
    const { policy } = await base();
    const ids = policy.guardians.map((g) => g.id);
    expect(
      code(() => assertPolicySound(with_(policy, { groupThreshold: 2 }))),
    ).toBe("group_threshold");
    expect(
      code(() =>
        assertPolicySound(
          with_(policy, {
            groups: [{ id: "all", threshold: 6, guardianIds: ids }],
          }),
        ),
      ),
    ).toBe("member_threshold");
    expect(
      code(() =>
        assertPolicySound(
          with_(policy, {
            groups: [{ id: "all", threshold: 1, guardianIds: ids }],
          }),
        ),
      ),
    ).toBe("member_threshold_one");
  });

  it("one credential claimed by two guardians", async () => {
    const { policy } = await base();
    const [first, second] = policy.guardians;
    if (!first || !second) throw new Error("setup");
    const stolen: Guardian = { ...second, credentials: first.credentials };
    const guardians = policy.guardians.map((g) =>
      g.id === second.id ? stolen : g,
    );
    expect(code(() => assertPolicySound(with_(policy, { guardians })))).toBe(
      "shared_credential",
    );
  });

  it("a guardian with no key that can wrap a share, for a circle that recovers", async () => {
    const { policy } = await base();
    const [first, ...rest] = policy.guardians;
    if (!first) throw new Error("setup");
    const weak: Guardian = {
      ...first,
      credentials: first.credentials.map((c) => ({ ...c, prf: false })),
    };
    expect(
      code(() =>
        assertPolicySound(with_(policy, { guardians: [weak, ...rest] })),
      ),
    ).toBe("no_prf");
    // The same guardian is fine in a circle that only authorizes actions.
    expect(() =>
      assertPolicySound(
        with_(policy, {
          guardians: [weak, ...rest],
          operations: ["grant-access"],
          shareCommitments: {},
        }),
      ),
    ).not.toThrow();
  });

  it("an origin outside the RP ID, and timings that cannot work", async () => {
    const { policy } = await base();
    expect(
      code(() =>
        assertPolicySound(
          with_(policy, { origins: ["https://evil.example.org"] }),
        ),
      ),
    ).toBe("rp_id");
    expect(
      code(() =>
        assertPolicySound(
          with_(policy, { releaseDelaySec: policy.requestLifetimeSec }),
        ),
      ),
    ).toBe("lifetime");
    expect(
      code(() =>
        assertPolicySound(
          with_(policy, { approvalWindowSec: policy.requestLifetimeSec + 60 }),
        ),
      ),
    ).toBe("lifetime");
  });

  it("missing or extra share commitments", async () => {
    const { policy } = await base();
    const { [policy.guardians[0]?.id ?? ""]: _dropped, ...rest } =
      policy.shareCommitments;
    expect(
      code(() => assertPolicySound(with_(policy, { shareCommitments: rest }))),
    ).toBe("commitments");
  });
});

describe("what a policy only warns about", () => {
  it("says nothing about a healthy 3-of-5", async () => {
    const { policy } = await base();
    expect(policyWarnings(policy)).toEqual([]);
  });

  it("names a single guardian, unanimity, no delay, touch-only approval and a one-household quorum", async () => {
    const { policy } = await base();
    const ids = policy.guardians.map((g) => g.id);
    const codes = (p: CirclePolicy) => policyWarnings(p).map((w) => w.code);
    expect(
      codes(
        with_(policy, {
          groups: [{ id: "all", threshold: 5, guardianIds: ids }],
        }),
      ),
    ).toContain("unanimity");
    expect(codes(with_(policy, { releaseDelaySec: 0 }))).toContain("no_delay");
    expect(codes(with_(policy, { requireUserVerification: false }))).toContain(
      "no_user_verification",
    );
    const sameHome = policy.guardians.map((g) => ({
      ...g,
      custodyDomain: "one-house",
    }));
    expect(codes(with_(policy, { guardians: sameHome }))).toContain(
      "quorum_in_one_domain",
    );
    const solo = policy.guardians.slice(0, 1);
    expect(
      codes(
        with_(policy, {
          guardians: solo,
          groups: [
            { id: "g", threshold: 1, guardianIds: solo.map((g) => g.id) },
          ],
          shareCommitments: Object.fromEntries(
            solo.map((g) => [g.id, policy.shareCommitments[g.id] ?? ""]),
          ),
        }),
      ),
    ).toContain("single_guardian");
  });
});

describe("satisfying a policy", () => {
  it("needs the member threshold in enough groups", async () => {
    const world = await buildWorld({
      names: ["F1", "F2", "F3", "P1", "P2", "P3", "P4"],
      groups: [
        { id: "family", threshold: 2, members: ["F1", "F2", "F3"] },
        { id: "friends", threshold: 2, members: ["P1", "P2", "P3", "P4"] },
      ],
      groupThreshold: 2,
      skipDelivery: true,
    });
    const { policy } = world.created.signedPolicy;
    const id = (n: string) => person(world, n).id;
    const set = (...n: string[]) => new Set(n.map(id));
    expect(satisfies(policy, set("F1", "F2", "P3", "P4"))).toBe(true);
    // Every family member, no friend: not enough groups.
    expect(satisfies(policy, set("F1", "F2", "F3"))).toBe(false);
    // One from each: not enough members in either.
    expect(satisfies(policy, set("F1", "P1"))).toBe(false);
    // Three friends and one relative: friends group only.
    expect(satisfies(policy, set("P1", "P2", "P3", "F1"))).toBe(false);
  });
});

describe("the owner's signature", () => {
  it("verifies for the owner and nobody else, and pins the owner key", async () => {
    const { world, policy } = await base();
    const signed = world.created.signedPolicy;
    expect(verifySignedPolicy(signed, world.owner.publicKey).digest).toBe(
      signed.digest,
    );
    expect(
      code(() =>
        verifySignedPolicy(signed, toB64url(new Uint8Array(32).fill(3))),
      ),
    ).toBe("owner_key_changed");
    expect(
      code(() =>
        verifySignedPolicy({
          ...signed,
          signature: toB64url(new Uint8Array(64)),
        }),
      ),
    ).toBe("bad_signature");
    const edited = { ...signed, policy: with_(policy, { label: "Mine now" }) };
    expect(code(() => verifySignedPolicy(edited))).toBe("digest_mismatch");
  });

  it("is refused when a different key signed it", async () => {
    const { world, policy } = await base();
    const intruder = crypto.getRandomValues(new Uint8Array(32));
    const forged = signPolicy(policy, intruder);
    expect(code(() => verifySignedPolicy(forged))).toBe("bad_signature");
    expect(world.owner.publicKey).toBe(policy.ownerKey);
  });
});

describe("canonical form and framing", () => {
  it("is independent of key order and rejects floats", () => {
    expect(canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      '{"a":[2,{"c":3,"d":4}],"b":1}',
    );
    expect(() => canonicalize({ x: 1.5 })).toThrow();
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
  });

  it("does not let text move across a field boundary", () => {
    expect(framedDigest("p", ["AliceCo", "123"])).not.toBe(
      framedDigest("p", ["AliceCo123", ""]),
    );
    expect(framedDigest("p", ["ab", "c"])).not.toBe(
      framedDigest("p", ["a", "bc"]),
    );
    expect(Array.from(frame(["ab"]))).toEqual([
      ...new TextEncoder().encode("2\0ab"),
    ]);
  });

  it("does not let a digest made for one purpose stand for another", () => {
    expect(framedDigest("one", ["x"])).not.toBe(framedDigest("two", ["x"]));
    expect(digestBytes(framedDigest("one", ["x"]))).toHaveLength(32);
    expect(() => digestBytes("sha256:zz")).toThrow();
  });

  it("changes the policy digest when any field changes", async () => {
    const { policy } = await base();
    const before = policyDigest(policy);
    expect(policyDigest(with_(policy, { epoch: 2 }))).not.toBe(before);
    expect(
      policyDigest(
        with_(policy, { releaseDelaySec: policy.releaseDelaySec + 1 }),
      ),
    ).not.toBe(before);
    expect(policyDigest({ ...policy })).toBe(before);
  });
});
