import { CAPABILITIES } from "@opensesame/capability-registry";
import { SUPPORT_LIMITS } from "@opensesame/support-agent";
import { describe, expect, it } from "vitest";
import { capabilitiesForContext } from "./capability-context.js";
import { buildSupportPageContext } from "./context.js";
import { GUIDE_ROUTES, isKnownGuideRoute } from "./routes.js";

describe("authored route-scoped capability context", () => {
  it("retains every PWA capability somewhere without raising the per-page budget", () => {
    const seen = new Set<string>();
    for (const route of GUIDE_ROUTES) {
      const capabilities = capabilitiesForContext(CAPABILITIES, route.id, []);
      expect(capabilities.length).toBeLessThanOrEqual(
        SUPPORT_LIMITS.maxCapabilities,
      );
      for (const capability of capabilities) seen.add(capability.id);
    }
    expect([...seen].sort()).toEqual(
      CAPABILITIES.filter((item) => item.surfaces.pwa !== null)
        .map((item) => item.id)
        .sort(),
    );
  });

  it("places Host pairing and metadata permissions on their relevant routes", () => {
    const ids = (route: string) =>
      capabilitiesForContext(CAPABILITIES, route, []).map((item) => item.id);
    expect(ids("/settings/connectivity")).toContain("browser.pairing.begin");
    expect(ids("/settings/connectivity")).toContain("configs.permissions.read");
    expect(ids("/connections")).toContain("browser.identity.authenticate");
    expect(ids("/vault")).not.toContain("configs.permissions.read");
    expect(ids("/vault")).not.toContain("browser.pairing.begin");
    expect(ids("/access-review")).not.toContain("tasks.list");
  });

  it("does not let unrelated registry growth fill another route's model context", () => {
    const unrelated = CAPABILITIES.find(
      (item) => item.id === "configs.permissions.read",
    );
    expect(unrelated).toBeDefined();
    if (!unrelated) throw new Error("Missing permissions regression fixture");
    const extended = [
      ...CAPABILITIES,
      ...Array.from({ length: 100 }, () => unrelated),
    ];
    expect(capabilitiesForContext(extended, "/vault", [])).toEqual(
      capabilitiesForContext(CAPABILITIES, "/vault", []),
    );
  });

  it("admits off-route capabilities when authored help answers that question", () => {
    const context = buildSupportPageContext({
      pageId: "pages",
      route: "/vault",
      hostReachable: false,
      identityReachable: false,
      question: "How do I pair this browser with the local host?",
    });
    expect(context.help.some((entry) => entry.goal === "browser.pair")).toBe(
      true,
    );
    expect(
      context.capabilities.find(
        (entry) => entry.id === "browser.pairing.begin",
      ),
    ).toMatchObject({ available: false });
    expect(context.capabilities.length).toBeLessThanOrEqual(
      SUPPORT_LIMITS.maxCapabilities,
    );
  });

  it("fails on an unscoped addition instead of silently dropping it", () => {
    const base = CAPABILITIES.find((item) => item.surfaces.pwa !== null);
    if (!base) throw new Error("Missing PWA fixture");
    expect(() =>
      capabilitiesForContext([{ ...base, id: "new.unscoped" }], "/vault", []),
    ).toThrow("support_capability_scope_missing:new.unscoped");
    expect(GUIDE_ROUTES.every((route) => isKnownGuideRoute(route.id))).toBe(
      true,
    );
  });
});
