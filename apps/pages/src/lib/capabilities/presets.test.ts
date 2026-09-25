import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isKnownCapability,
  optionalCapabilityIds,
} from "@opensesame/app-core/lib/capabilities/catalog.js";
import {
  PRESETS,
  isRestrictedForHome,
  presetById,
  presetToInstancePolicy,
} from "@opensesame/app-core/lib/capabilities/presets.js";
import {
  isModuleId,
  parseDistributionContract,
  parseInstancePolicy,
} from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import {
  GENERATED_PUBLIC_FILES,
  HTML_ENTRY_OWNERSHIP,
  MODULE_OWNERSHIP,
  PLANNED_MODULE_ENTRIES,
  PUBLIC_FILE_OWNERSHIP,
  distributionFromOwnership,
  modulesOwnedBy,
} from "./ownership.js";

const here = dirname(fileURLToPath(import.meta.url));
const pagesRoot = join(here, "..", "..", "..");

describe("MODULE_OWNERSHIP", () => {
  it("owns one runtime module per optional capability and the push worker", () => {
    for (const id of optionalCapabilityIds()) {
      expect(MODULE_OWNERSHIP[`${id}/runtime`]?.entry, id).toBe(
        `src/modules/${id}/runtime.ts`,
      );
    }
    expect(MODULE_OWNERSHIP["notifications.web-push/worker"]).toEqual({
      entry: "src/sw-push.ts",
      capability: "notifications.web-push",
      environments: ["service-worker"],
    });
    expect(modulesOwnedBy("notifications.web-push")).toEqual([
      "notifications.web-push/runtime",
      "notifications.web-push/worker",
    ]);
  });

  it("module ids are well-formed and name their capability", () => {
    for (const [moduleId, ownership] of Object.entries(MODULE_OWNERSHIP)) {
      expect(isModuleId(moduleId), moduleId).toBe(true);
      expect(moduleId.startsWith(`${ownership.capability}/`), moduleId).toBe(
        true,
      );
      expect(isKnownCapability(ownership.capability), moduleId).toBe(true);
      expect(ownership.environments.length).toBeGreaterThan(0);
    }
  });

  it("every entry exists on disk unless it is still planned", () => {
    const planned = new Set(PLANNED_MODULE_ENTRIES);
    const missing: string[] = [];
    const landed: string[] = [];
    for (const ownership of Object.values(MODULE_OWNERSHIP)) {
      const exists = existsSync(join(pagesRoot, ownership.entry));
      if (planned.has(ownership.entry)) {
        if (exists) landed.push(ownership.entry);
        continue;
      }
      if (!exists) missing.push(ownership.entry);
    }
    expect(
      missing,
      `unplanned entries missing on disk:\n${missing.join("\n")}`,
    ).toEqual([]);
    // Planned entries that have landed are reported so the list can shrink.
    if (landed.length > 0) {
      console.info(`planned module entries now on disk:\n${landed.join("\n")}`);
    }
  });

  it("HTML and public files name known owners; core public files are null", () => {
    expect(HTML_ENTRY_OWNERSHIP["auth/redirect.html"]).toBe(
      "identity.ambient-sso",
    );
    for (const owner of Object.values(HTML_ENTRY_OWNERSHIP)) {
      expect(isKnownCapability(owner)).toBe(true);
    }
    expect(PUBLIC_FILE_OWNERSHIP["icon.svg"]).toBeNull();
    expect(PUBLIC_FILE_OWNERSHIP["os-runtime-config.json"]).toBeNull();
    expect(PUBLIC_FILE_OWNERSHIP["security-profile.json"]).toBeNull();
    expect(PUBLIC_FILE_OWNERSHIP["auth.js"]).toBe("identity.site-broker");
    expect(PUBLIC_FILE_OWNERSHIP["static-auth/**"]).toBe(
      "identity.site-broker",
    );
    expect(PUBLIC_FILE_OWNERSHIP[".well-known/**"]).toBe("identity.ceremonies");
    for (const [file, owner] of Object.entries(PUBLIC_FILE_OWNERSHIP)) {
      if (owner !== null) expect(isKnownCapability(owner), file).toBe(true);
      const writer = GENERATED_PUBLIC_FILES[file];
      // A file a build step writes has its writer on disk instead.
      if (writer !== undefined) {
        expect(existsSync(join(pagesRoot, writer)), file).toBe(true);
        continue;
      }
      const onDisk = file.endsWith("/**") ? file.slice(0, -3) : file;
      expect(existsSync(join(pagesRoot, "public", onDisk)), file).toBe(true);
    }
  });

  it("distributionFromOwnership is a valid contract in both modes", () => {
    for (const mode of ["selective", "hardened"] as const) {
      const distribution = distributionFromOwnership(mode);
      const parsed = parseDistributionContract(
        JSON.parse(JSON.stringify(distribution)),
      );
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(distribution.moduleIds).toEqual(
        Object.keys(MODULE_OWNERSHIP).sort(),
      );
      expect(distribution.workerVariants.map((variant) => variant.id)).toEqual([
        "core-only",
        "push",
      ]);
    }
  });
});

describe("PRESETS", () => {
  it("has the five ids, version 2 (ADR 0142), and only known capability ids", () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([
      "personal",
      "family",
      "homelab",
      "organization",
      "custom",
    ]);
    for (const preset of PRESETS) {
      expect(preset.version).toBe(2);
      for (const id of [
        ...preset.required,
        ...preset.optional,
        ...preset.defaultSelected,
      ]) {
        expect(isKnownCapability(id), `${preset.id}: ${id}`).toBe(true);
      }
      // Pre-ticked ids are offered ids.
      const offered = new Set([...preset.required, ...preset.optional]);
      for (const id of preset.defaultSelected) {
        expect(
          offered.has(id),
          `${preset.id} pre-selects unoffered ${id}`,
        ).toBe(true);
      }
      // An always-on capability is in every plan; a preset never names it.
      for (const id of [
        ...preset.required,
        ...preset.optional,
        ...preset.defaultSelected,
      ]) {
        expect(optionalCapabilityIds(), `${preset.id}: ${id}`).toContain(id);
      }
      expect(new Set(preset.optional).size).toBe(preset.optional.length);
      for (const id of preset.required)
        expect(preset.optional).not.toContain(id);
    }
  });

  it("personal and family neither offer nor pre-select connectors, enterprise, agents, remote AI or telemetry", () => {
    for (const id of ["personal", "family"] as const) {
      const preset = presetById(id);
      for (const offered of [
        ...preset.optional,
        ...preset.defaultSelected,
        ...preset.required,
      ]) {
        expect(isRestrictedForHome(offered), `${id} offers ${offered}`).toBe(
          false,
        );
      }
      expect(preset.optional).not.toContain("notifications.web-push");
    }
    expect(presetById("family").network.externalServices).toBe("deny");
    expect(presetById("personal").network.externalServices).toBe("allow");
  });

  it("homelab and organization offer but never pre-select the external families", () => {
    for (const id of ["homelab", "organization"] as const) {
      const preset = presetById(id);
      for (const family of [
        "support.remote-ai",
        "enterprise.ca-administration",
        "agents.webmcp",
      ]) {
        expect(
          [...preset.optional, ...preset.required],
          `${id} offers ${family}`,
        ).toContain(family);
      }
      for (const selected of preset.defaultSelected) {
        expect(
          isRestrictedForHome(selected),
          `${id} pre-selects ${selected}`,
        ).toBe(false);
      }
    }
  });

  it("custom offers every optional capability and pre-selects nothing", () => {
    const custom = presetById("custom");
    expect([...custom.optional].sort()).toEqual(
      [...optionalCapabilityIds()].sort(),
    );
    expect(custom.defaultSelected).toEqual([]);
    expect(custom.required).toEqual([]);
  });

  it("presetToInstancePolicy is pure and parses as a policy that refuses the unoffered", () => {
    for (const preset of PRESETS) {
      const policy = presetToInstancePolicy(preset, "inst-test", "r1");
      expect(policy).toEqual(presetToInstancePolicy(preset, "inst-test", "r1"));
      const parsed = parseInstancePolicy(JSON.parse(JSON.stringify(policy)));
      expect(parsed.ok, `${preset.id}: ${JSON.stringify(parsed)}`).toBe(true);
      const all = new Set([
        ...policy.capabilities.required,
        ...policy.capabilities.optional,
        ...policy.capabilities.prohibited,
      ]);
      expect([...all].sort()).toEqual([...optionalCapabilityIds()].sort());
      expect(policy.presetProvenance).toEqual({ id: preset.id, version: 2 });
      expect(policy.capabilities.default).toBe("deny");
    }
    expect(
      presetToInstancePolicy(presetById("family"), "i", "r").capabilities
        .prohibited,
    ).toContain("telemetry.external");
  });
});
