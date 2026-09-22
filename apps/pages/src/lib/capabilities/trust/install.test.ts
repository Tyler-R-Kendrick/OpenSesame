import type { InstanceCapabilityPolicy } from "@opensesame/capability-composition";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  durable,
  failures,
  installKv,
  managedRuntimeConfig,
} from "../__tests__/harness.js";
import { FAMILY_POLICY, NOW } from "../__tests__/plan-fixtures.js";
import { storeSeams } from "../store-seams.js";
import { ACCEPTED_POLICY_KEY } from "./accepted-revision.js";
import { policyPayloadDigest } from "./envelope.js";
import {
  installTrustSeams,
  pendingTrustWrites,
  workspaceRestrictionKey,
} from "./install.js";

const VAULT = "tomb-1";

function policyAt(revision: string): InstanceCapabilityPolicy {
  return { ...FAMILY_POLICY, revision };
}

/** A different document under the same revision (TRUST-06). */
function twinOf(policy: InstanceCapabilityPolicy): InstanceCapabilityPolicy {
  return {
    ...policy,
    capabilities: { ...policy.capabilities, optional: ["access.authority"] },
  };
}

async function accept(policy: InstanceCapabilityPolicy): Promise<void> {
  durable.set(
    ACCEPTED_POLICY_KEY,
    JSON.stringify({
      instanceId: policy.instanceId,
      revision: policy.revision,
      digest: await policyPayloadDigest(policy),
      provenance: "same-origin-deployment",
      acceptedAt: NOW,
    }),
  );
}

async function review(policy: InstanceCapabilityPolicy, vaultId = VAULT) {
  await installTrustSeams(managedRuntimeConfig(policy), vaultId);
  return storeSeams.reviewManagedPolicy(policy);
}

describe("installTrustSeams — managed policy review (S03)", () => {
  beforeEach(() => {
    durable.clear();
    failures.durableWrite = false;
    installKv();
    storeSeams.now = () => NOW;
  });
  afterEach(async () => {
    await pendingTrustWrites();
  });

  it("accepts a first managed policy and records the witness it will judge the next one by", async () => {
    const policy = policyAt("family-r2");
    expect(await review(policy)).toEqual({ ok: true, diagnostics: [] });
    await pendingTrustWrites();
    expect(JSON.parse(durable.get(ACCEPTED_POLICY_KEY) ?? "null")).toEqual({
      instanceId: policy.instanceId,
      revision: "family-r2",
      digest: await policyPayloadDigest(policy),
      provenance: "same-origin-deployment",
      acceptedAt: NOW,
    });
  });

  it("TRUST-05: an older revision is a rollback and is refused", async () => {
    await accept(policyAt("family-r10"));
    const outcome = await review(policyAt("family-r2"));
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics[0]).toContain("rollback refused");
    await pendingTrustWrites();
    // The witness still names the revision this device accepted.
    expect(durable.get(ACCEPTED_POLICY_KEY)).toContain("family-r10");
  });

  it("TRUST-06: the same revision carrying a different document is refused", async () => {
    const accepted = policyAt("family-r3");
    await accept(accepted);
    const outcome = await review(twinOf(accepted));
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics[0]).toContain("conflict refused");
    // Re-serving the document that was accepted is not a conflict.
    expect(await review(accepted)).toEqual({ ok: true, diagnostics: [] });
  });

  it("refuses a policy naming another instance, and one that was never digested", async () => {
    await accept(policyAt("family-r1"));
    const foreign = { ...FAMILY_POLICY, instanceId: "fixture-other" };
    const outcome = await review(foreign);
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics[0]).toContain("names instance fixture-other");

    // A document the boot never primed is unknown, and unknown fails closed.
    await installTrustSeams(managedRuntimeConfig(policyAt("family-r9")), null);
    const unprimed = storeSeams.reviewManagedPolicy(twinOf(policyAt("family-r9")));
    expect(unprimed.ok).toBe(false);
    expect(unprimed.diagnostics[0]).toContain("not verified before boot");
  });

  it("reports a witness write it could not keep instead of implying one", async () => {
    failures.durableWrite = true;
    const policy = policyAt("family-r4");
    expect((await review(policy)).ok).toBe(true);
    await pendingTrustWrites();
    expect(durable.has(ACCEPTED_POLICY_KEY)).toBe(false);
    const next = storeSeams.reviewManagedPolicy(policy);
    expect(next.diagnostics[0]).toContain("rollback detection is not armed");
  });
});

describe("workspace restriction seam (S03/S04)", () => {
  const restriction = {
    schemaVersion: 1,
    kind: "WorkspaceCapabilityRestriction",
    instanceId: FAMILY_POLICY.instanceId,
    vaultId: VAULT,
    revision: "w-1",
    allow: ["connectors.external"],
    prohibited: ["sharing.drops"],
  };

  beforeEach(async () => {
    durable.clear();
    installKv();
    storeSeams.now = () => NOW;
    await installTrustSeams(managedRuntimeConfig(FAMILY_POLICY), VAULT);
  });

  it("reads the narrowing stored for this vault and ignores one scoped elsewhere", () => {
    durable.set(workspaceRestrictionKey(VAULT), JSON.stringify(restriction));
    expect(
      storeSeams.workspaceRestriction(FAMILY_POLICY.instanceId, VAULT),
    ).toEqual(restriction);
    expect(storeSeams.workspaceRestriction("fixture-other", VAULT)).toBeNull();
    durable.set(
      workspaceRestrictionKey(VAULT),
      JSON.stringify({ ...restriction, vaultId: "tomb-2" }),
    );
    expect(
      storeSeams.workspaceRestriction(FAMILY_POLICY.instanceId, VAULT),
    ).toBeNull();
  });

  it("absent where nothing is stored; narrowest where a document will not parse", () => {
    expect(
      storeSeams.workspaceRestriction(FAMILY_POLICY.instanceId, VAULT),
    ).toBeNull();
    expect(
      storeSeams.workspaceRestriction(FAMILY_POLICY.instanceId, null),
    ).toBeNull();
    for (const stored of ["{not json", JSON.stringify({ kind: "Other" })]) {
      durable.set(workspaceRestrictionKey(VAULT), stored);
      expect(
        storeSeams.workspaceRestriction(FAMILY_POLICY.instanceId, VAULT),
      ).toEqual({
        schemaVersion: 1,
        kind: "WorkspaceCapabilityRestriction",
        instanceId: FAMILY_POLICY.instanceId,
        vaultId: VAULT,
        revision: "unreadable",
        allow: [],
        prohibited: [],
      });
    }
  });
});
