import { describe, expect, it } from "vitest";
import { FEATURE_BINDING_CATEGORIES } from "../../sections/connections/shared.js";
import { coreCapabilityIds } from "./catalog.js";
import { FEATURES, featureById } from "./features.js";
import { BUILT_IN_INTEGRATIONS, INTEGRATIONS } from "./integrations.js";

describe("INTEGRATIONS", () => {
  it("gives every offered connector family one section while removing legacy local storage", () => {
    const homes = INTEGRATIONS.flatMap((entry) => entry.providerCategories);
    expect(new Set(homes).size).toBe(homes.length);
    expect([...homes].sort()).toEqual(
      FEATURE_BINDING_CATEGORIES.filter(
        (category) => category !== "local_storage",
      ).sort(),
    );
    expect(homes).not.toContain("local_storage");
  });

  it("names every section once", () => {
    const ids = INTEGRATIONS.map((entry) => entry.id);
    const titles = INTEGRATIONS.map((entry) => entry.title);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("is no feature flag: a connector is configured by reference", () => {
    for (const entry of INTEGRATIONS) {
      expect(entry, entry.id).not.toHaveProperty("capabilities");
    }
    for (const feature of FEATURES) {
      expect(feature, feature.id).not.toHaveProperty("providerCategories");
    }
  });

  it("extends the feature it shares an id with, under the same name", () => {
    for (const entry of INTEGRATIONS) {
      const shared = FEATURES.find((feature) => feature.id === entry.id);
      expect(entry.extendsFeature, entry.id).toBe(shared?.id);
      if (shared !== undefined) {
        expect(entry.title, entry.id).toBe(featureById(shared.id).title);
      }
    }
  });

  it("leaves the built-in functions with no feature section at all (ADR 0142)", () => {
    expect([...BUILT_IN_INTEGRATIONS].sort()).toEqual([
      "backups",
      "cloud-secret-storage",
      "encryption",
      "password-managers",
    ]);
    for (const id of BUILT_IN_INTEGRATIONS) {
      expect(
        FEATURES.some((feature) => feature.id === id),
        id,
      ).toBe(false);
    }
  });

  it("puts git providers under Backups and AI provider connections under AI", () => {
    expect(
      INTEGRATIONS.find((entry) => entry.id === "backups")?.providerCategories,
    ).toEqual(["backup_recovery"]);
    expect(
      INTEGRATIONS.find((entry) => entry.id === "ai")?.providerCategories,
    ).toEqual(["agent_harnesses", "ai_model_provider"]);
    for (const entry of INTEGRATIONS)
      expect(entry).not.toHaveProperty("models");
  });

  it("names only always-on capabilities as what a section is backed by (ADR 0142)", () => {
    for (const entry of INTEGRATIONS) {
      for (const id of entry.backedBy ?? []) {
        expect(coreCapabilityIds(), `${entry.id}: ${id}`).toContain(id);
      }
    }
  });
});
