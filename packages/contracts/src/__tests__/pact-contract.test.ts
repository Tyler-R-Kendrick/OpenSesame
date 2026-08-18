import { describe, expect, it } from "vitest";
import {
  CreateClaimRequestSchema,
  CreateClaimResponseSchema,
} from "../claims.js";
import { PrincipalMeResponseSchema } from "../principals.js";
import {
  FORBIDDEN_TASKBUS_RESPONSE_KEYS,
  PutTaskBusRequestSchema,
  TaskBusConfigSchema,
} from "../taskbus.js";
import { taskBusOpenApi } from "../taskbus.openapi.js";
import {
  assertFailClosedStatuses,
  assertNoSecretFields,
} from "@opensesame/testing";

describe("PACT — published contracts fail closed", () => {
  it("TaskBus OpenAPI documents authz and forbids secret fields", () => {
    const paths = taskBusOpenApi.paths;
    assertFailClosedStatuses(paths["/api/v1/operator/taskbus"].get.responses, [
      "401",
      "403",
    ]);
    assertFailClosedStatuses(paths["/api/v1/operator/taskbus"].put.responses, [
      "400",
      "401",
      "403",
    ]);
    assertFailClosedStatuses(
      paths["/api/v1/operator/taskbus/ping"].post.responses,
      ["401", "403", "422"],
    );
    assertNoSecretFields(taskBusOpenApi.components.schemas.TaskBusConfig);
    for (const leak of FORBIDDEN_TASKBUS_RESPONSE_KEYS) {
      expect(
        Object.keys(taskBusOpenApi.components.schemas.TaskBusConfig.properties),
      ).not.toContain(leak);
    }
  });

  it("Zod parsers reject attacker-controlled extras and http NATS URLs", () => {
    expect(() =>
      PutTaskBusRequestSchema.parse({
        backend: "nats",
        nats_url: "http://evil.example/nats",
      }),
    ).toThrow();
    expect(() =>
      TaskBusConfigSchema.parse({
        backend: "memory",
        source: "default",
        status: "ok",
        access_token: "leak",
      }),
    ).toThrow();
    expect(() =>
      CreateClaimRequestSchema.parse({
        type: "not-a-claim",
        targetManifest: {},
      }),
    ).toThrow();
  });

  it("success envelopes do not smuggle unexpected secrets", () => {
    const claim = CreateClaimResponseSchema.parse({
      claimId: "clm_1",
      claimToken: "osc_clm_abcdefghijklmnopqrstuvwxyz012345",
      userCode: "ABCD-EFGH",
      verificationUri: "https://id.example/v1/claims/clm_1/verify",
      expiresAt: "2026-08-18T00:00:00.000Z",
      targetManifestDigest: "sha256:abc",
      pollIntervalSeconds: 5,
    });
    assertNoSecretFields(claim, ["claimToken"]);
    const me = PrincipalMeResponseSchema.parse({
      id: "prn_1",
      state: "provisional",
      assurance: "provisional",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      version: 1,
      identities: [],
    });
    assertNoSecretFields(me);
  });

  it("property: claim types round-trip and unknown types fail closed", () => {
    const types = [
      "principal",
      "agent",
      "project",
      "resource_bundle",
      "device",
      "connection",
    ] as const;
    for (const type of types) {
      const parsed = CreateClaimRequestSchema.parse({
        type,
        targetManifest: { kind: type },
        ttlSeconds: 60,
      });
      expect(parsed.type).toBe(type);
    }
    for (const type of ["implicit", "admin", "secret", ""]) {
      expect(
        CreateClaimRequestSchema.safeParse({
          type,
          targetManifest: {},
        }).success,
      ).toBe(false);
    }
  });

  it("chaos: extra credential fields on TaskBus configs are rejected", () => {
    for (const leak of ["access_token", "refresh_token", "client_secret", "pem"]) {
      expect(
        TaskBusConfigSchema.safeParse({
          backend: "memory",
          source: "default",
          status: "ok",
          [leak]: "nope",
        }).success,
      ).toBe(false);
    }
  });
});
