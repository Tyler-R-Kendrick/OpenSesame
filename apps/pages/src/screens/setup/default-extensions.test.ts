/** @vitest-environment node */
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { FEATURES } from "@opensesame/app-core/lib/capabilities/features.js";
import { describe, expect, it } from "vitest";
import {
  profilePlan,
  profileSelection,
} from "../../lib/capabilities/__tests__/vault-profiles.js";
import { DEFAULT_EXTENSIONS } from "./default-extensions.js";

const SECTIONS = new Set(["identity", "access", "connections", "item-types"]);

describe("default extensions", () => {
  it("is Identity, Connections, Access and item types, without ambient sign-in", () => {
    const fromSections = FEATURES.filter((feature) => SECTIONS.has(feature.id))
      .flatMap((feature) => [...feature.capabilities])
      .filter((id) => id !== "identity.ambient-sso")
      .sort();
    expect([...DEFAULT_EXTENSIONS].sort()).toEqual(fromSections);
    for (const id of DEFAULT_EXTENSIONS) {
      const entry = CAPABILITY_CATALOG.capabilities.find(
        (capability) => capability.id === id,
      );
      expect(entry?.tier, id).toBe("optional");
    }
    for (const id of [
      "identity.ambient-sso",
      "support.local-ai",
      "support.remote-ai",
      "agents.webmcp",
      "vault.browser-autofill",
    ]) {
      expect(DEFAULT_EXTENSIONS).not.toContain(id);
    }
  });

  it("resolves on the minimal profile and approves each module", () => {
    const plan = profilePlan("minimal-local", {
      installation: {
        ...profileSelection("minimal-local"),
        selectedOptional: [...DEFAULT_EXTENSIONS],
        delivery: { prefetch: "selected", offlineCache: "selected-only" },
      },
    });
    for (const id of DEFAULT_EXTENSIONS) {
      expect(plan.capabilities[id]?.approved, id).toBe(true);
      expect(plan.approvedModules, id).toContain(`${id}/runtime`);
    }
    expect(plan.capabilities["identity.ambient-sso"]?.approved).toBe(false);
    expect(plan.capabilities["support.local-ai"]?.approved).toBe(false);
    expect(plan.approvedItemKinds).toContain("account");
    expect(plan.approvedItemKinds).toContain("secret");
  });
});
