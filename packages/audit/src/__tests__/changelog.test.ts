import type { AuditEvent } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  SECRET_CHANGELOG_EVENT_TYPES,
  filterSecretChangelogEvents,
  isSecretChangelogEventType,
  recordSecretChangelog,
} from "../changelog.js";
import { redactAuditMetadata } from "../redact.js";

function memorySink() {
  const rows: AuditEvent[] = [];
  return {
    rows,
    append: async (event: AuditEvent) => {
      rows.push(event);
      return event;
    },
  };
}

describe("secret changelog", () => {
  it("exports the frozen event type strings", () => {
    expect(SECRET_CHANGELOG_EVENT_TYPES).toContain("secret.config.created");
    expect(SECRET_CHANGELOG_EVENT_TYPES).toContain("secret.value.changed");
    expect(SECRET_CHANGELOG_EVENT_TYPES).toContain("sync.target.synced");
    expect(SECRET_CHANGELOG_EVENT_TYPES).toContain(
      "credential.rotation.requested",
    );
    expect(isSecretChangelogEventType("secret.config.deleted")).toBe(true);
    expect(isSecretChangelogEventType("organization.created")).toBe(false);
  });

  it("records metadata with key names and strips secret values", async () => {
    const store = memorySink();
    const event = await recordSecretChangelog(store, {
      eventType: "secret.value.changed",
      projectId: "project_1",
      principalId: "prn_actor",
      actorId: "prn_actor",
      actorType: "human",
      metadata: {
        configId: "cfg_api",
        environment: "production",
        keyNames: ["DATABASE_URL", "API_TOKEN"],
        versionId: "ver_9",
        value: "should-never-land",
        secret: "also-no",
        password: "nope",
        token: "leak",
        apiToken: "still-no",
      },
    });

    expect(event.eventType).toBe("secret.value.changed");
    expect(event.projectId).toBe("project_1");
    expect(event.metadata).toEqual({
      configId: "cfg_api",
      environment: "production",
      keyNames: ["DATABASE_URL", "API_TOKEN"],
      versionId: "ver_9",
    });
    expect(JSON.stringify(event.metadata)).not.toMatch(/should-never-land/);
    expect(JSON.stringify(event.metadata)).not.toMatch(/also-no|nope|leak/);
  });

  it("records sync.target.synced with target id + content version only", async () => {
    const store = memorySink();
    const event = await recordSecretChangelog(store, {
      eventType: "sync.target.synced",
      projectId: "project_1",
      metadata: {
        targetId: "st_1",
        contentVersion: "cv_42",
        configId: "cfg_api",
        secretBody: "ciphertext-or-plaintext-must-drop",
      },
    });
    expect(event.metadata).toEqual({
      targetId: "st_1",
      contentVersion: "cv_42",
      configId: "cfg_api",
    });
  });

  it("filters a mixed trail to changelog types", () => {
    const filtered = filterSecretChangelogEvents(
      [
        { eventType: "organization.created", projectId: "p1" },
        { eventType: "secret.config.created", projectId: "p1" },
        { eventType: "secret.value.changed", projectId: "p2" },
        { eventType: "sync.target.failed", projectId: "p1" },
      ],
      { projectId: "p1", limit: 10 },
    );
    expect(filtered.map((e) => e.eventType)).toEqual([
      "secret.config.created",
      "sync.target.failed",
    ]);
  });
});

describe("redactAuditMetadata changelog keys", () => {
  it("drops value/secret/password/token fields case-insensitively", () => {
    const out = redactAuditMetadata({
      configId: "cfg_1",
      Value: "x",
      SECRET: "y",
      Password: "z",
      TOKEN: "t",
      keyNames: ["A", "B"],
      environment: "staging",
    });
    expect(out).toEqual({
      configId: "cfg_1",
      keyNames: ["A", "B"],
      environment: "staging",
    });
  });
});
