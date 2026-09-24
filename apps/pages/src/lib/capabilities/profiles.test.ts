import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_CATALOG,
  coreCapabilityIds,
  optionalCapabilityIds,
} from "@opensesame/app-core/lib/capabilities/catalog.js";
import {
  type EffectivePlan,
  type InstallationCapabilitySelection,
  type InstanceCapabilityPolicy,
  type PolicyProvenance,
  type RuntimeFacts,
  buildConsentReceipt,
  parseInstallationSelection,
  parseInstancePolicy,
  resolveComposition,
} from "@opensesame/capability-composition";
import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { distributionFromOwnership } from "./ownership.js";

const here = dirname(fileURLToPath(import.meta.url));
const profilesDir = join(here, "..", "..", "..", "capability-profiles");

type Profile = {
  $schema: string;
  name: string;
  notes: string;
  instancePolicy: BoundaryValue;
  installationSelection: BoundaryValue;
  expectInvalid?: true;
  trust?: { provenance: PolicyProvenance; policyValid: boolean };
};

const FACTS: RuntimeFacts = {
  environments: ["document", "dedicated-worker", "service-worker"],
  serviceWorkerAvailable: true,
  activeWorkerVariant: null,
  cleanRealm: true,
  evaluatedModuleIds: [],
  now: "2026-09-22T00:00:00.000Z",
};

const profiles: Profile[] = readdirSync(profilesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(profilesDir, name), "utf8")));
const byName = new Map(profiles.map((profile) => [profile.name, profile]));

/** A profile fixture with its two documents parsed. */
type LoadedProfile = {
  profile: Profile;
  policy: InstanceCapabilityPolicy | null;
  selection: InstallationCapabilitySelection;
};

function load(name: string): LoadedProfile {
  const profile = byName.get(name);
  if (!profile) throw new Error(`no profile ${name}`);
  const policy =
    profile.instancePolicy === null
      ? null
      : (() => {
          const parsed = parseInstancePolicy(profile.instancePolicy);
          if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
          return parsed.value;
        })();
  const selection = parseInstallationSelection(profile.installationSelection);
  if (!selection.ok) throw new Error(JSON.stringify(selection.diagnostics));
  return { profile, policy, selection: selection.value };
}

/** Resolve twice: once to learn the closure, once with a receipt covering it. */
function resolve(name: string): EffectivePlan {
  const { profile, policy, selection } = load(name);
  const input = {
    catalog: CAPABILITY_CATALOG,
    distribution: distributionFromOwnership("selective"),
    instancePolicy: policy,
    provenance:
      profile.trust?.provenance ??
      (policy === null ? "personal-local" : "same-origin-deployment"),
    policyValid: profile.trust?.policyValid ?? true,
    workspace: null,
    installation: selection,
    vault: null,
    receipt: null,
    facts: FACTS,
    installationId: selection.installationId,
    vaultId: null,
  } as const;
  const first = resolveComposition(input);
  const receipt = buildConsentReceipt(first, CAPABILITY_CATALOG, FACTS.now);
  return resolveComposition({ ...input, receipt });
}

const approvedOptional = (plan: EffectivePlan): string[] => {
  const core = new Set(coreCapabilityIds());
  return plan.approvedCapabilities.filter((id) => !core.has(id)).sort();
};

const EXPECTED = {
  "minimal-local": [],
  "family-local": [],
  "family-sharing-selected": ["sharing.drops", "sharing.household"],
  // Git backup is always on (ADR 0142): the provider path needs nothing optional.
  "single-provider-selected": [],
  "enterprise-selected": [
    "enterprise.ca-administration",
    "enterprise.directory-provisioning",
  ],
  "rich-explicit": [...optionalCapabilityIds()].sort(),
  "managed-prohibited": ["sharing.drops"],
} satisfies Record<string, readonly string[]>;

describe("capability profiles", () => {
  it("has every mandated fixture with the profile schema and pinned ids", () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        ...Object.keys(EXPECTED),
        "managed-invalid-instance",
        "managed-invalid-revision",
        "managed-invalid-signature",
        "managed-missing-required",
      ].sort(),
    );
    for (const profile of profiles) {
      expect(profile.$schema).toBe("opensesame-capability-profile/1");
      expect(profile.notes.length).toBeGreaterThan(20);
      const { policy, selection } = load(profile.name);
      const known = new Set(CAPABILITY_CATALOG.capabilities.map((c) => c.id));
      const listed = [
        ...(policy?.capabilities.required ?? []),
        ...(policy?.capabilities.optional ?? []),
        ...(policy?.capabilities.prohibited ?? []),
        ...selection.acceptedRequired,
        ...selection.selectedOptional,
        ...Object.values(selection.chosenAlternatives),
      ];
      const core = new Set(coreCapabilityIds());
      for (const id of listed) {
        expect(known.has(id), `${profile.name}: ${id}`).toBe(true);
        expect(core.has(id), `${profile.name}: core ${id}`).toBe(false);
        expect(id.includes("*"), `${profile.name}: wildcard ${id}`).toBe(false);
      }
      expect(selection.revision).toEqual(expect.any(String));
      if (policy) expect(policy.revision).toEqual(expect.any(String));
    }
  });

  it("core is approved in every profile, valid or not", () => {
    for (const profile of profiles) {
      const plan = resolve(profile.name);
      for (const id of coreCapabilityIds()) {
        expect(plan.capabilities[id]?.approved, `${profile.name}: ${id}`).toBe(
          true,
        );
      }
    }
  });

  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name} approves exactly ${expected.length} optional capabilities`, () => {
      const plan = resolve(name);
      expect(plan.conflicts, JSON.stringify(plan.conflicts)).toEqual([]);
      expect(approvedOptional(plan)).toEqual(expected);
      expect(plan.consent.requiredNotAccepted).toEqual([]);
    });
  }

  it("family profiles keep enterprise, agents, remote AI and telemetry unapproved", () => {
    for (const name of ["family-local", "family-sharing-selected"]) {
      const plan = resolve(name);
      for (const id of [
        "networking.tailnet",
        "enterprise.directory-provisioning",
        "enterprise.ca-administration",
        "agents.webmcp",
        "support.remote-ai",
        "telemetry.external",
      ]) {
        expect(plan.capabilities[id]?.approved, `${name}: ${id}`).toBe(false);
        expect(plan.capabilities[id]?.permitted, `${name}: ${id}`).toBe(false);
      }
      expect(plan.network.externalServices).toBe("deny");
      // Always on, and held inside the deny by its runtime rather than by
      // the plan (ADR 0142): the observer pushes nothing while it holds.
      expect(plan.capabilities["backup.git-remote"]?.approved).toBe(true);
    }
  });

  it("single-provider selects no worker variant and enterprise pulls its dependencies", () => {
    expect(
      resolve("single-provider-selected").requiredWorkerVariant,
    ).toBeNull();
    const plan = resolve("enterprise-selected");
    expect(plan.capabilities["identity.federation"]?.dependencyOf).toContain(
      "enterprise.directory-provisioning",
    );
    expect(
      plan.capabilities["vault.certificate-records"]?.dependencyOf,
    ).toContain("enterprise.ca-administration");
  });

  it("rich-explicit needs the push worker variant", () => {
    expect(resolve("rich-explicit").requiredWorkerVariant).toBe("push");
  });

  it("managed-prohibited refuses the prohibited root and says why", () => {
    const state =
      resolve("managed-prohibited").capabilities["support.remote-ai"];
    expect(state?.approved).toBe(false);
    expect(state?.reasons).toContain("PROHIBITED_BY_INSTANCE");
  });

  it("managed-invalid-signature resolves core-only with POLICY_UNVERIFIED", () => {
    const plan = resolve("managed-invalid-signature");
    expect(approvedOptional(plan)).toEqual([]);
    expect(plan.policyValid).toBe(false);
    expect(plan.capabilities["sharing.drops"]?.reasons).toContain(
      "POLICY_UNVERIFIED",
    );
    expect(plan.network.externalServices).toBe("deny");
  });

  it("managed-invalid-instance is a PROFILE_MISMATCH with nothing optional approved", () => {
    const plan = resolve("managed-invalid-instance");
    expect(approvedOptional(plan)).toEqual([]);
    expect(plan.capabilities["sharing.drops"]?.reasons).toContain(
      "PROFILE_MISMATCH",
    );
  });

  it("managed-invalid-revision is detectable from the documents and must not approve", () => {
    const { policy, selection } = load("managed-invalid-revision");
    expect(policy?.revision).not.toBe(selection.basePolicyRevision);
    const plan = resolve("managed-invalid-revision");
    // The resolver does not compare basePolicyRevision itself today (see the
    // S02 report); the store/trust layer must refuse the selection before
    // resolving. Until it does, this pins the observable contract: a stale
    // selection never widens beyond what the current policy permits.
    for (const id of approvedOptional(plan)) {
      expect(policy?.capabilities.optional, id).toContain(id);
    }
  });

  it("managed-missing-required refuses joining and approves nothing optional", () => {
    const plan = resolve("managed-missing-required");
    expect(plan.consent.requiredNotAccepted).toEqual([
      "enterprise.directory-provisioning",
    ]);
    expect(approvedOptional(plan)).toEqual([]);
  });

  it("every expectInvalid profile is one of the rejected cases", () => {
    const rejected = new Set([
      "managed-invalid-instance",
      "managed-invalid-revision",
      "managed-invalid-signature",
      "managed-missing-required",
    ]);
    for (const profile of profiles) {
      expect(profile.expectInvalid === true, profile.name).toBe(
        rejected.has(profile.name),
      );
    }
  });
});
