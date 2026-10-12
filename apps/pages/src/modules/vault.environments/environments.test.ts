/**
 * Vault environments are optional: off by default, absent from the minimal
 * installation, and a write asked for while they are off stores nothing.
 */

import { optionalCapabilityIds } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { writeEnvironments } from "@opensesame/app-core/lib/vault/environments-write.js";
import { ENVIRONMENTS_CAPABILITY } from "@opensesame/app-core/lib/vault/environments.js";
import { describe, expect, it } from "vitest";
import {
  profilePlan,
  profileSelection,
} from "../../lib/capabilities/__tests__/vault-profiles.js";

describe("vault environments capability", () => {
  it("is optional, off by default, and absent from the minimal installation", () => {
    const minimal = profilePlan("minimal-local");
    const selection = profileSelection("minimal-local");
    expect(optionalCapabilityIds()).toContain(ENVIRONMENTS_CAPABILITY);
    expect(minimal.approvedCapabilities).not.toContain(ENVIRONMENTS_CAPABILITY);
    expect(minimal.capabilities[ENVIRONMENTS_CAPABILITY]?.selected).toBe(false);
    expect(minimal.capabilities[ENVIRONMENTS_CAPABILITY]?.approved).toBe(false);
    expect(selection.selectedOptional).not.toContain(ENVIRONMENTS_CAPABILITY);
    expect(minimal.approvedModules).not.toContain(
      `${ENVIRONMENTS_CAPABILITY}/runtime`,
    );
  });

  it("is approved when an installation selects it", () => {
    const plan = profilePlan("minimal-local", {
      installation: {
        ...profileSelection("minimal-local"),
        selectedOptional: [ENVIRONMENTS_CAPABILITY],
      },
    });
    expect(plan.approvedCapabilities).toContain(ENVIRONMENTS_CAPABILITY);
    expect(plan.approvedModules).toContain(
      `${ENVIRONMENTS_CAPABILITY}/runtime`,
    );
  });

  it("refuses every write while the minimal installation is the plan", async () => {
    const minimal = profilePlan("minimal-local");
    for (const edit of [
      { op: "add-environment", name: "production" },
      { op: "add-key", itemId: "any" },
      {
        op: "set-cell",
        itemId: "any",
        environment: "production",
        cell: { required: true },
      },
    ] as const) {
      expect(await writeEnvironments(minimal, edit)).toEqual({
        ok: false,
        reason: "disabled",
      });
    }
  });
});
