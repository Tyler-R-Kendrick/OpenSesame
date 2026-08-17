import { describe, expect, it } from "vitest";
import {
  PERSONAL_PROJECT_SLUG,
  type SecretConfig,
  type SecretsPlaneDomainEventType,
  type SyncTarget,
} from "../types.js";
import { fixtures } from "./fixtures.js";

describe("personal project fixtures and frozen event names", () => {
  it("builds a personal project with tomb and vault bindings", () => {
    const project = fixtures.personalProject();
    expect(project.slug).toBe(PERSONAL_PROJECT_SLUG);
    expect(project.state).toBe("active");
    expect(project.sealedStoreTombName).toBe("personal");
    expect(project.pagesVaultFolderId).toBe("vault_folder_personal");
  });

  it("exposes SecretConfig and SyncTarget shapes without secret values", () => {
    const config: SecretConfig = {
      id: "cfg_001",
      projectId: "prj_personal_001",
      slug: "dev",
      displayName: "Development",
      environment: "development",
    };
    const target: SyncTarget = {
      id: "sync_001",
      projectId: config.projectId,
      configId: config.id,
      connectionId: "conn_001",
      providerId: "vercel",
      operation: "env.set",
      status: "idle",
    };
    expect(config.environment).toBe("development");
    expect(target.status).toBe("idle");
    expect("value" in config).toBe(false);
  });

  it("freezes secrets-plane event type strings", () => {
    const events: SecretsPlaneDomainEventType[] = [
      "project.personal.ensured",
      "secret.config.created",
      "secret.config.updated",
      "secret.config.deleted",
      "secret.value.changed",
      "sync.target.created",
      "sync.target.synced",
      "sync.target.failed",
      "credential.rotation.requested",
      "credential.rotation.succeeded",
      "credential.rotation.failed",
    ];
    expect(events).toHaveLength(11);
  });
});
