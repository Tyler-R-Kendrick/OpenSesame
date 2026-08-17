import { describe, expect, it } from "vitest";
import {
  CreateSyncTargetRequestSchema,
  ListSyncTargetsResponseSchema,
  SyncAllResponseSchema,
  SyncTargetOutcomeSchema,
  SyncTargetRequestSchema,
  SyncTargetSchema,
  SyncTargetStatusSchema,
} from "../index.js";

const target = {
  id: "sync_target:01J",
  project_id: "project:1",
  config_id: "config:prod",
  connection_id: "connection:1",
  provider_id: "vercel",
  operation: "env.set",
  status: "idle",
  status_detail: null,
  content_version: null,
  last_synced_at: null,
  organization_id: "organization:1",
  created_at: "2026-08-17T12:00:00.000Z",
  updated_at: "2026-08-17T12:00:00.000Z",
};

describe("sync-targets contract", () => {
  it("parses sync target shapes", () => {
    expect(SyncTargetSchema.parse(target).provider_id).toBe("vercel");
    expect(SyncTargetStatusSchema.options).toEqual([
      "idle",
      "syncing",
      "ready",
      "error",
    ]);
    expect(
      CreateSyncTargetRequestSchema.parse({
        project_id: "project:1",
        config_id: "config:prod",
        connection_id: "connection:1",
      }).connection_id,
    ).toBe("connection:1");
    expect(
      ListSyncTargetsResponseSchema.parse({ sync_targets: [target] })
        .sync_targets,
    ).toHaveLength(1);
  });

  it("rejects credential material on sync target responses", () => {
    for (const leak of [
      { access_token: "at_live" },
      { refresh_token: "rt_live" },
      { client_secret: "cs_live" },
      { value: "secret-value" },
    ]) {
      expect(() => SyncTargetSchema.parse({ ...target, ...leak })).toThrow();
    }
    expect(() =>
      SyncTargetOutcomeSchema.parse({
        target: { ...target, access_token: "at_live" },
        ok: true,
        keys_synced: 0,
      }),
    ).toThrow();
    expect(() =>
      SyncAllResponseSchema.parse({
        outcomes: [
          {
            target: { ...target, password: "pw" },
            ok: true,
            keys_synced: 0,
          },
        ],
      }),
    ).toThrow();
  });

  it("allows key_names only on sync request — not values", () => {
    expect(
      SyncTargetRequestSchema.parse({ key_names: ["DATABASE_URL"] }).key_names,
    ).toEqual(["DATABASE_URL"]);
    expect(() =>
      SyncTargetRequestSchema.parse({
        key_names: ["DATABASE_URL"],
        values: { DATABASE_URL: "secret" },
      }),
    ).toThrow();
  });
});
