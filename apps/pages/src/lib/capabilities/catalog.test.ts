import {
  CAPABILITY_CATALOG,
  PROMPT_EXAMPLE_IDS,
  coreCapabilityIds,
  describeCapability,
  modularCapabilityIds,
} from "@opensesame/app-core/lib/capabilities/catalog.js";
import { runtimeModule } from "@opensesame/app-core/lib/capabilities/descriptor.js";
import {
  type CapabilityDescriptor,
  isCapabilityId,
  isModuleId,
  validateCatalog,
} from "@opensesame/capability-composition";
import { OPERATION_CAPABILITY } from "@opensesame/capability-registry";
import { describe, expect, it } from "vitest";
import { MODULE_OWNERSHIP } from "./ownership.js";

const byId = new Map(
  CAPABILITY_CATALOG.capabilities.map((entry) => [entry.id, entry]),
);
const descriptor = (id: string): CapabilityDescriptor => {
  const found = byId.get(id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

describe("CAPABILITY_CATALOG (S02-F)", () => {
  it("validates as a unit", () => {
    const result = validateCatalog(CAPABILITY_CATALOG);
    expect(result, JSON.stringify(result, null, 2)).toEqual({ ok: true });
  });

  it("has unique, well-formed ids and a positive catalog version", () => {
    const ids = CAPABILITY_CATALOG.capabilities.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isCapabilityId(id), id).toBe(true);
    expect(CAPABILITY_CATALOG.catalogVersion).toBe(1);
  });

  it("keeps every id the mandate's example documents use", () => {
    for (const id of PROMPT_EXAMPLE_IDS) {
      expect(describeCapability(id), id).not.toBeNull();
    }
  });

  it("keeps the ownership.md §5 core set, the shell root and the always-on set", () => {
    expect(coreCapabilityIds().sort()).toEqual(
      [
        "backup.local-encrypted",
        "identity.brokered-signin",
        "install.pwa",
        "settings.core",
        "shell.navigation",
        "vault.local-unlock",
        "vault.passwords",
        // Always-on: core in every plan, code delivered as a module.
        "access.authority",
        "activity.log",
        "backup.cloud-secrets",
        "connectors.external",
        "identity.ambient-sso",
        "identity.federation",
        "support.guided-help",
        "vault.certificate-records",
        "vault.interop-formats",
        "vault.passkey-records",
      ].sort(),
    );
  });

  it("no core descriptor depends on or offers an optional alternative", () => {
    for (const id of coreCapabilityIds()) {
      const entry = descriptor(id);
      for (const dependency of entry.dependencies) {
        expect(descriptor(dependency).tier, `${id} → ${dependency}`).toBe(
          "core",
        );
      }
      expect(entry.alternatives).toEqual([]);
    }
  });

  it("a core descriptor is statically linked or always-on with exactly its runtime module", () => {
    for (const id of coreCapabilityIds()) {
      const modules = descriptor(id).moduleIds;
      if (modules.length > 0) expect(modules, id).toEqual([runtimeModule(id)]);
    }
  });

  it("every modular descriptor names <id>/runtime first and every module id is owned", () => {
    for (const id of modularCapabilityIds()) {
      const entry = descriptor(id);
      expect(entry.moduleIds[0], id).toBe(runtimeModule(id));
      for (const moduleId of entry.moduleIds) {
        expect(isModuleId(moduleId), moduleId).toBe(true);
        expect(MODULE_OWNERSHIP[moduleId], moduleId).toBeDefined();
        expect(MODULE_OWNERSHIP[moduleId]?.capability).toBe(id);
      }
    }
  });

  it("every owned module is declared by exactly its capability", () => {
    for (const [moduleId, ownership] of Object.entries(MODULE_OWNERSHIP)) {
      expect(descriptor(ownership.capability).moduleIds).toContain(moduleId);
    }
  });

  it("operationIds equal the registry's OPERATION_CAPABILITY grouped by value", () => {
    const grouped = new Map<string, string[]>();
    for (const [operation, capability] of Object.entries(
      OPERATION_CAPABILITY,
    )) {
      grouped.set(capability, [...(grouped.get(capability) ?? []), operation]);
    }
    for (const capability of grouped.keys()) {
      expect(byId.has(capability), `map names unknown ${capability}`).toBe(
        true,
      );
    }
    for (const entry of CAPABILITY_CATALOG.capabilities) {
      expect([...entry.operationIds].sort(), entry.id).toEqual(
        (grouped.get(entry.id) ?? []).sort(),
      );
    }
  });

  it("core operations are owned by core capabilities", () => {
    const core = new Set(coreCapabilityIds());
    for (const operation of [
      "app.navigate",
      "identity.login",
      "vault.items.search",
      "vaults.switch",
      "vault.export",
      "setup.first_run",
      "app.install",
    ]) {
      expect(core.has(OPERATION_CAPABILITY[operation] ?? ""), operation).toBe(
        true,
      );
    }
  });

  it("declares the exposure the mandate names", () => {
    expect(descriptor("sharing.household").alternatives).toEqual([
      { slot: "transport", oneOf: ["sharing.drops"] },
    ]);
    expect(descriptor("sharing.drops").egress).toContainEqual(
      expect.objectContaining({ class: "external-service", automatic: false }),
    );
    expect(descriptor("support.remote-ai").egress).toContainEqual(
      expect.objectContaining({ class: "external-service", automatic: true }),
    );
    expect(descriptor("telemetry.external").egress).toContainEqual(
      expect.objectContaining({ class: "external-service", automatic: true }),
    );
    expect(descriptor("identity.ambient-sso").dependencies).toContain(
      "identity.federation",
    );
    expect(descriptor("backup.git-remote").dependencies).toContain(
      "connectors.external",
    );
    const push = descriptor("notifications.web-push");
    expect(push.workerGraphConstraint).toBe("push");
    expect(push.environments).toContain("service-worker");
    expect(push.moduleIds).toEqual([
      "notifications.web-push/runtime",
      "notifications.web-push/worker",
    ]);
    expect(push.browserPermissions).toContain("notifications");
    expect(descriptor("agents.webmcp").requiresDocumentReload).toBe(true);
    expect(descriptor("vault.passkey-records").browserPermissions).toContain(
      "webauthn",
    );
    expect(descriptor("vault.passwords").browserPermissions).toContain(
      "clipboard-write",
    );
  });

  it("item kinds are owned once and by the capabilities the mandate names", () => {
    const owners = new Map<string, string>();
    for (const entry of CAPABILITY_CATALOG.capabilities) {
      for (const kind of entry.itemKinds) {
        expect(owners.has(kind), `${kind} owned twice`).toBe(false);
        owners.set(kind, entry.id);
      }
    }
    expect(owners.get("login")).toBe("vault.passwords");
    expect(owners.get("note")).toBe("vault.passwords");
    expect(owners.get("card")).toBe("vault.passwords");
    expect(owners.get("secret")).toBe("vault.passwords");
    expect(owners.get("passkey")).toBe("vault.passkey-records");
    expect(owners.get("certificate")).toBe("vault.certificate-records");
    expect(owners.get("drop")).toBe("sharing.drops");
  });

  it("descriptors are data: no functions anywhere", () => {
    const walk = (value: unknown, path: string): void => {
      expect(typeof value, path).not.toBe("function");
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          walk(child, `${path}.${key}`);
        }
      }
    };
    walk(CAPABILITY_CATALOG, "catalog");
  });

  it("every exposure digest is sha256-prefixed and distinct per declared exposure", () => {
    for (const entry of CAPABILITY_CATALOG.capabilities) {
      expect(entry.exposureDigest, entry.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});
