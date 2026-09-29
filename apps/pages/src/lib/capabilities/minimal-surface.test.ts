/**
 * ADR 0153 — the minimal plan is vault, activity and settings. Connections,
 * Access and Identity are absent until their capability flags are selected.
 * The vault's approved item kinds are the base secret only.
 */

import { capabilityFlagKey } from "@opensesame/app-core/lib/capabilities/openfeature.js";
import type { CapabilityId } from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { profilePlan, profileSelection } from "./__tests__/vault-profiles.js";

const SECTIONS = [
  "connectors.external",
  "access.authority",
  "identity.local-iam",
] as const satisfies readonly CapabilityId[];

const SECTION_FLAGS = [
  ...SECTIONS,
  "identity.siop",
  "identity.federation",
  "identity.ambient-sso",
  "vault.derived-records",
  "vault.passkey-records",
  "vault.certificate-records",
] as const satisfies readonly CapabilityId[];

describe("minimal surface", () => {
  it("approves vault, activity and settings, and no optional section", () => {
    const plan = profilePlan("minimal-local");
    for (const id of ["vault.passwords", "activity.log", "settings.core"]) {
      expect(plan.capabilities[id]?.approved, id).toBe(true);
    }
    expect(plan.approvedModules).toContain("activity.log/runtime");
    expect(plan.approvedItemKinds).toEqual(["secret"]);
    for (const id of [
      ...SECTION_FLAGS,
      "support.local-ai",
      "support.remote-ai",
      "agents.webmcp",
    ]) {
      expect(plan.capabilities[id]?.approved, id).toBe(false);
      expect(plan.approvedModules, id).not.toContain(`${id}/runtime`);
      expect(capabilityFlagKey(id)).toBe(`capability.${id}`);
    }
  });

  it("installs a section when its capability flag is selected", () => {
    const plan = profilePlan("minimal-local", {
      installation: {
        ...profileSelection("minimal-local"),
        selectedOptional: [...SECTION_FLAGS],
      },
    });
    for (const id of SECTION_FLAGS) {
      expect(plan.capabilities[id]?.approved, id).toBe(true);
      expect(plan.approvedModules, id).toContain(`${id}/runtime`);
    }
    expect(plan.approvedItemKinds).toContain("secret");
    expect(plan.approvedItemKinds).toContain("login");
    expect(plan.approvedItemKinds).toContain("passkey");
    expect(plan.approvedItemKinds).not.toContain("drop");
  });
});
