import { describe, expect, it } from "vitest";
import { retiredSettingsAddress } from "./settings-retired.js";

const at = (path: string, search = "", hash = "") =>
  retiredSettingsAddress(path, search, hash);

describe("a link to a retired Settings address", () => {
  it("reads Capabilities as Features", () => {
    expect(at("/settings/capabilities")).toBe("/settings/features");
    expect(at("/settings/capabilities/")).toBe("/settings/features");
    expect(at("/settings", "", "#capabilities")).toBe("/settings/features");
  });

  it("keeps a switch's section on Features, under the same anchor", () => {
    expect(at("/settings/capabilities", "", "#feature-identity")).toBe(
      "/settings/features#feature-identity",
    );
    expect(at("/settings/capabilities", "", "#instance-policy")).toBe(
      "/settings/features#instance-policy",
    );
    expect(at("/settings/capabilities", "", "#feature-guests")).toBe(
      "/settings/features#feature-guests",
    );
  });

  it("sends a built-in function's section to Integrations", () => {
    for (const id of [
      "encryption",
      "backups",
      "password-managers",
      "cloud-secret-storage",
    ]) {
      expect(at("/settings/capabilities", "", `#feature-${id}`)).toBe(
        `/settings/integrations#integration-${id}`,
      );
    }
  });

  it("keeps the removed local-storage section on the general Features fallback", () => {
    expect(at("/settings/capabilities", "", "#feature-local-storage")).toBe(
      "/settings/features#feature-local-storage",
    );
  });

  it("sends a bare connector family to its tile list on Integrations", () => {
    expect(at("/settings/capabilities", "", "#backup_recovery")).toBe(
      "/settings/integrations#backup_recovery",
    );
    expect(at("/settings/connections", "", "#wallet")).toBe(
      "/settings/integrations#wallet",
    );
  });

  it("reads the older provider categories as Integrations, to their section", () => {
    expect(at("/settings/connections")).toBe("/settings/integrations");
    expect(at("/settings/connectivity")).toBe("/settings/integrations");
    expect(at("/settings/taskbus")).toBe("/settings/integrations");
    expect(at("/settings/backups")).toBe(
      "/settings/integrations#integration-backups",
    );
    expect(at("/settings", "", "#cloud-secrets")).toBe(
      "/settings/integrations#integration-cloud-secret-storage",
    );
  });

  it("moves a capability document with its directory", () => {
    expect(
      at(
        "/settings/capabilities",
        "?file=settings%2Fcapabilities%2Feffective-plan.yaml",
      ),
    ).toBe("/settings/features?file=settings%2Ffeatures%2Feffective-plan.yaml");
    expect(at("/settings/capabilities", "?file=config.yaml")).toBe(
      "/settings/features?file=config.yaml",
    );
  });

  it("leaves a current address, a connector's page and other categories alone", () => {
    expect(at("/settings/features")).toBeNull();
    expect(at("/settings/integrations", "", "#integration-backups")).toBeNull();
    expect(at("/settings/connections/github")).toBeNull();
    expect(at("/settings/connections/github/work")).toBeNull();
    expect(at("/settings/security")).toBeNull();
    expect(at("/settings", "", "#unlock")).toBeNull();
    expect(at("/settings")).toBeNull();
    expect(at("/vault")).toBeNull();
  });
});
