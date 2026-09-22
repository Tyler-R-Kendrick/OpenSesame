import type { BoundaryValue } from "@opensesame/os-domain";
import { compileProfile } from "./compile-profile.js";
import { diag, recoveryCycle, scopesOverlap } from "./compiler-util.js";
import { defined } from "./defined.js";
import type {
  CompilerCatalog,
  CompilerDiagnostic,
  EffectAssurance,
  ExposureSummary,
} from "./evidence.js";
import type { PolicyDocument } from "./policy.js";
import { PolicyDocumentSchema } from "./policy.js";

export type CompileResult =
  | {
      ok: true;
      policy: PolicyDocument;
      exposures: ExposureSummary[];
      assurances: EffectAssurance[];
      /** Import `enabled: true` never arms — armed requires enrollment ceremony. */
      armed: false;
    }
  | {
      ok: false;
      diagnostics: CompilerDiagnostic[];
    };

function parseCompileInput(
  input: PolicyDocument | BoundaryValue,
): ReturnType<typeof PolicyDocumentSchema.safeParse> {
  return PolicyDocumentSchema.safeParse(input);
}

function collectCatalogDiagnostics(
  policy: PolicyDocument,
  catalog: CompilerCatalog,
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];

  if (!catalog.durableStorage && policy.profiles.length > 0) {
    diagnostics.push(
      diag(
        "undurable_storage",
        "catalog.durableStorage",
        "Duress profiles require durable local storage.",
      ),
    );
  }

  if (
    catalog.minPolicyRevision !== undefined &&
    policy.revision < catalog.minPolicyRevision
  ) {
    diagnostics.push(
      diag(
        "stale_policy",
        "revision",
        `Policy revision ${policy.revision} is older than catalog minimum ${catalog.minPolicyRevision}.`,
      ),
    );
  }

  if (
    catalog.expectedSessionDigest != null &&
    catalog.expectedSessionDigest !== (catalog.presentedSessionDigest ?? null)
  ) {
    diagnostics.push(
      diag(
        "stale_session",
        "session",
        "Presented session digest does not match expected binding.",
      ),
    );
  }

  return diagnostics;
}

function collectProfileGraphDiagnostics(
  policy: PolicyDocument,
  catalog: CompilerCatalog,
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];

  for (const profile of policy.profiles) {
    const ref = profile.effects.recoveryPolicyRef;
    if (ref && recoveryCycle(ref, catalog.recoveryEdges ?? [])) {
      diagnostics.push(
        diag(
          "circular_recovery",
          `profiles.${profile.profileId}.effects.recoveryPolicyRef`,
          "Recovery policy graph contains a cycle.",
        ),
      );
    }
  }

  for (let i = 0; i < policy.profiles.length; i++) {
    for (let j = i + 1; j < policy.profiles.length; j++) {
      const a = defined(policy.profiles[i], "profile a");
      const b = defined(policy.profiles[j], "profile b");
      if (a.triggerKind === b.triggerKind && scopesOverlap(a.scope, b.scope)) {
        diagnostics.push(
          diag(
            "ambiguous_trigger",
            `profiles.${a.profileId}`,
            `Trigger ${a.triggerKind} overlaps scope with ${b.profileId}.`,
          ),
        );
      }
    }
  }

  const profileIds = new Set<string>();
  for (const profile of policy.profiles) {
    if (profileIds.has(profile.profileId)) {
      diagnostics.push(
        diag(
          "ambiguous_trigger",
          `profiles.${profile.profileId}`,
          "Duplicate profileId.",
        ),
      );
    }
    profileIds.add(profile.profileId);
  }

  return diagnostics;
}

function collectPolicyDiagnostics(
  policy: PolicyDocument,
  catalog: CompilerCatalog,
): CompilerDiagnostic[] {
  return [
    ...collectCatalogDiagnostics(policy, catalog),
    ...collectProfileGraphDiagnostics(policy, catalog),
  ];
}

/**
 * Pure policy compiler. Import/dry-run never arms triggers (INV-02 / AT-002).
 */
export function compileDuressPolicy(
  input: PolicyDocument | BoundaryValue,
  catalog: CompilerCatalog,
): CompileResult {
  const parsed = parseCompileInput(input);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => {
        const path = issue.path.join(".") || "(root)";
        if (
          path === "schemaVersion" ||
          issue.message.includes("schemaVersion")
        ) {
          return diag("unsupported_profile_version", path, issue.message);
        }
        return diag("unsupported_factor", path, issue.message);
      }),
    };
  }

  const policy = parsed.data;
  if (policy.schemaVersion !== 1) {
    return {
      ok: false,
      diagnostics: [
        diag(
          "unsupported_profile_version",
          "schemaVersion",
          "Only schemaVersion 1 is supported.",
        ),
      ],
    };
  }

  const diagnostics = collectPolicyDiagnostics(policy, catalog);

  const exposures: ExposureSummary[] = [];
  const assurances: EffectAssurance[] = [];
  for (const profile of policy.profiles) {
    const result = compileProfile(profile, catalog, diagnostics);
    exposures.push(result.exposure);
    assurances.push(...result.assurances);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    policy,
    exposures,
    assurances,
    armed: false,
  };
}

export type DryRunDiff = {
  policyId: string;
  revision: number;
  enabledFlag: boolean;
  wouldArm: false;
  profileIds: string[];
  exposures: ExposureSummary[];
  missingReadiness: string[];
  diagnostics: CompilerDiagnostic[];
};

function collectMissingReadiness(readiness: {
  ownerConsent: boolean;
  rehearsalPassed: boolean;
  durableStorage: boolean;
  enrolledTriggers: boolean;
}): string[] {
  const missing: string[] = [];
  if (!readiness.ownerConsent) missing.push("owner_consent");
  if (!readiness.rehearsalPassed) missing.push("isolated_rehearsal");
  if (!readiness.durableStorage) missing.push("durable_storage");
  if (!readiness.enrolledTriggers) missing.push("enrolled_triggers");
  return missing;
}

/** Configuration dry-run: never mutates, never arms. */
export function dryRunDuressPolicy(
  input: PolicyDocument | BoundaryValue,
  catalog: CompilerCatalog,
  readiness: {
    ownerConsent: boolean;
    rehearsalPassed: boolean;
    durableStorage: boolean;
    enrolledTriggers: boolean;
  },
): DryRunDiff {
  const compiled = compileDuressPolicy(input, catalog);
  if (!compiled.ok) {
    return {
      policyId: "unknown",
      revision: 0,
      enabledFlag: false,
      wouldArm: false,
      profileIds: [],
      exposures: [],
      missingReadiness: ["compile_failed"],
      diagnostics: compiled.diagnostics,
    };
  }

  const missing = collectMissingReadiness(readiness);
  if (compiled.policy.enabled && missing.length > 0) {
    // enabled in YAML is not authorization
  }

  return {
    policyId: compiled.policy.policyId,
    revision: compiled.policy.revision,
    enabledFlag: compiled.policy.enabled,
    wouldArm: false,
    profileIds: compiled.policy.profiles.map((p) => p.profileId),
    exposures: compiled.exposures,
    missingReadiness: missing,
    diagnostics: [],
  };
}
