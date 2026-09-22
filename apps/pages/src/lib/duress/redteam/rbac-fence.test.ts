/**
 * REDTEAM-B / AUTH: RBAC promotion while duress fence active (INV-11).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as directory from "../../local-directory.js";

describe("REDTEAM-B RBAC fence fail-closed (finding RT-AUTH-001)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("MUST force guest when fence active even if AccessContext is null", async () => {
    vi.spyOn(directory, "readLocalDirectory").mockResolvedValue({
      version: 2,
      revision: 1,
      entries: [],
      memberships: [],
    });

    const { duressSessionFence } = await import("../session/fence.js");
    duressSessionFence.setContext(null);
    duressSessionFence.activate({
      incidentId: `rt-rbac-${Date.now()}`,
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["comp-decoy"],
    });
    expect(duressSessionFence.currentContext()).toBeNull();
    expect(
      duressSessionFence.readFence().activeIncidentIds.length,
    ).toBeGreaterThan(0);

    const { resolveCurrentAccessRole } = await import("../../local-rbac.js");
    const role = await resolveCurrentAccessRole("rt-existing-tomb");
    // Active fence + null ctx must not promote to operator via custodian fallthrough.
    expect(role).toBe("guest");
  });
});
