import { describe, expect, it } from "vitest";
import { CAPABILITIES, SURFACES, surfaceGaps } from "./index.js";

describe("password workflow boundaries", () => {
  const workflows = CAPABILITIES.filter(
    (capability) =>
      capability.id.startsWith("vault.workflow.") ||
      capability.id.startsWith("password_provider."),
  );

  it("declares every surface without introducing an unreviewed gap", () => {
    expect(workflows).toHaveLength(22);
    for (const capability of workflows) {
      for (const surface of SURFACES) {
        expect(surfaceGaps()[surface]).not.toContain(capability.id);
      }
    }
  });

  it("keeps private inputs, outputs and process execution off agent tools", () => {
    const metadataIds = new Set([
      "vault.workflow.find_references",
      "vault.workflow.inventory",
      "vault.workflow.audit_organization",
      "vault.workflow.env_template",
    ]);
    const humanHandoffIds = new Set([
      "vault.workflow.create_private",
      "vault.workflow.compare_private",
      "vault.workflow.update_private",
      "password_provider.read",
      "password_provider.env_resolve",
    ]);
    for (const capability of workflows) {
      expect(capability.surfaces.mcp_host).toBeNull();
      expect(capability.surfaces.mcp_client).toBeNull();
      if (metadataIds.has(capability.id)) {
        expect(capability.surfaces.webmcp).not.toBeNull();
      } else if (humanHandoffIds.has(capability.id)) {
        expect(capability.surfaces.webmcp).toBe(
          "opensesame_open_password_workflow",
        );
        expect(capability.excluded?.webmcp).toBeUndefined();
      } else {
        expect(capability.surfaces.webmcp).toBeNull();
        expect(capability.excluded?.webmcp).toBeDefined();
      }
    }
  });

  it("never claims browser process execution or provider authentication", () => {
    for (const id of [
      "run",
      "env_run",
      "doctor",
      "account_connect",
      "account_setup",
      "account_status",
      "account_recover",
      "account_forget",
    ]) {
      const capability = workflows.find(
        (entry) => entry.id === `password_provider.${id}`,
      );
      expect(capability?.surfaces.pwa).toBeNull();
      expect(capability?.excluded?.pwa?.adr).toBe(
        "0177-password-workflow-surface-boundaries.md",
      );
    }
  });
  it("leaves native requests and leases to the human CLI, with the browser excluded by custody", () => {
    for (const id of [
      "request",
      "lease_approve",
      "lease_status",
      "lease_revoke",
    ]) {
      const capability = workflows.find(
        (entry) => entry.id === `password_provider.${id}`,
      );
      expect(capability?.surfaces.cli).toMatch(
        /^opensesame-id (request|lease)/,
      );
      expect(capability?.surfaces.pwa).toBeNull();
      expect(capability?.excluded?.pwa?.adr).toBeDefined();
      expect(capability?.excluded?.webmcp?.reason).toContain("human CLI");
    }
  });
  it("registers the native password-agent command family with honest custody exclusions", () => {
    const capability = workflows.find(
      (entry) => entry.id === "password_provider.native_cli",
    );
    expect(capability?.surfaces.cli).toBe("opensesame password-agent");
    for (const surface of SURFACES.filter((surface) => surface !== "cli")) {
      expect(capability?.surfaces[surface]).toBeFalsy();
      expect(capability?.excluded?.[surface]?.adr).toBeDefined();
    }
  });
});
