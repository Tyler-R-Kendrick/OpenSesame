import { describe, expect, it } from "vitest";
import {
  MEMBERSHIP_SUBJECT_KINDS,
  assertAuthorityRelationAllowed,
  authorityKindFromTrustSubject,
  bindProofOfPossession,
  isAuthorityPrincipalKind,
  isMembershipSubjectKind,
  refuseDeviceResourceAsPrincipal,
  toMembershipSubjectKind,
} from "../authority-principals.js";
import {
  assertDistinctSpawnIdentity,
  mintWorkloadInstanceId,
  refuseUnsupportedWorkloadRuntime,
  spawnWorkloadIdentity,
} from "../authority-spawn.js";
import { DomainError } from "../errors.js";

describe("ID-BIND authority principal kinds", () => {
  it("recognizes the closed principal kind set", () => {
    expect(isAuthorityPrincipalKind("person")).toBe(true);
    expect(isAuthorityPrincipalKind("actor_instance")).toBe(true);
    expect(isAuthorityPrincipalKind("workload_instance")).toBe(true);
    expect(isAuthorityPrincipalKind("managed_device_resource")).toBe(false);
  });

  it("aligns membership subject kinds with the database CHECK set", () => {
    expect([...MEMBERSHIP_SUBJECT_KINDS]).toEqual([
      "person",
      "service",
      "agent_registration",
      "workload_instance",
      "device",
    ]);
    expect(isMembershipSubjectKind("actor_instance")).toBe(false);
    expect(() => toMembershipSubjectKind("actor_instance")).toThrow(
      DomainError,
    );
  });

  it("maps trust SubjectKind without widening actor instances", () => {
    expect(authorityKindFromTrustSubject("human")).toBe("person");
    expect(authorityKindFromTrustSubject("agent")).toBe("agent_registration");
    expect(authorityKindFromTrustSubject("workload")).toBe("workload_instance");
  });

  it("refuses treating a managed device resource as a principal", () => {
    expect(() =>
      refuseDeviceResourceAsPrincipal({
        kind: "managed_device_resource",
        resourceId: "device:phone-1",
        realmId: "org:home",
      }),
    ).toThrow(/not an authenticated principal/);
  });

  it("refuses interchangeable kinds on typed relation edges", () => {
    expect(() =>
      assertAuthorityRelationAllowed({
        relation: "member_of",
        from: {
          kind: "actor_instance",
          principalId: "prn_actor",
          realmId: "org:1",
        },
        to: { kind: "person", principalId: "prn_human", realmId: "org:1" },
      }),
    ).toThrow(/refuses ends/);

    expect(() =>
      assertAuthorityRelationAllowed({
        relation: "runs_on",
        from: { kind: "person", principalId: "prn_human", realmId: "org:1" },
        to: {
          kind: "managed_device_resource",
          resourceId: "device:1",
          realmId: "org:1",
        },
      }),
    ).toThrow(/refuses ends/);

    expect(() =>
      assertAuthorityRelationAllowed({
        relation: "acts_for",
        from: {
          kind: "actor_instance",
          principalId: "same",
          realmId: "org:1",
        },
        to: {
          kind: "agent_registration",
          principalId: "same",
          realmId: "org:1",
        },
      }),
    ).toThrow(/same principalId cannot carry two authority kinds/);
  });

  it("allows a workload to run on a managed device resource", () => {
    expect(() =>
      assertAuthorityRelationAllowed({
        relation: "runs_on",
        from: {
          kind: "workload_instance",
          principalId: "prn_wl",
          realmId: "org:1",
        },
        to: {
          kind: "managed_device_resource",
          resourceId: "device:lab",
          realmId: "org:1",
        },
      }),
    ).not.toThrow();
  });

  it("binds PoP enrollment to actor/device/workload with a generation", () => {
    const bound = bindProofOfPossession({
      subjectKind: "actor_instance",
      principalId: "prn_actor",
      publicKeyJkt: "jkt_abcdef12",
      authorityGeneration: 1,
      boundAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(bound.subjectKind).toBe("actor_instance");
    expect(bound.authorityGeneration).toBe(1);
    expect(() =>
      bindProofOfPossession({
        subjectKind: "device",
        principalId: "prn_dev",
        publicKeyJkt: "short",
        authorityGeneration: 1,
        boundAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ).toThrow(/public key thumbprint/);
  });
});

describe("ID-SPAWN workload identity", () => {
  const orchestrator = {
    kind: "agent_registration" as const,
    principalId: "agent:orch",
    realmId: "org:1",
  };

  it("mints unique instance ids under one registration", () => {
    const a = mintWorkloadInstanceId({
      agentRegistrationId: "agent:orch",
      taskId: "task:1",
      ordinal: 0,
    });
    const b = mintWorkloadInstanceId({
      agentRegistrationId: "agent:orch",
      taskId: "task:1",
      ordinal: 1,
    });
    expect(a).not.toEqual(b);
    assertDistinctSpawnIdentity({
      agentRegistrationId: "agent:orch",
      workloadInstanceId: a,
    });
  });

  it("refuses reusing the registration id as the instance id", () => {
    expect(() =>
      assertDistinctSpawnIdentity({
        agentRegistrationId: "agent:orch",
        workloadInstanceId: "agent:orch",
      }),
    ).toThrow(/must not equal/);
  });

  it("binds task, access domain, runtime, and generation on spawn", () => {
    const spawned = spawnWorkloadIdentity({
      orchestrator,
      taskId: "task:42",
      accessDomainId: "domain:workcell",
      runtimeProfile: "wasmtime",
      authorityGeneration: 3,
      publicKeyJkt: "jkt_spawned1",
      ordinal: 0,
      boundAt: new Date("2026-09-15T00:00:00Z"),
    });
    expect(spawned.kind).toBe("workload_instance");
    expect(spawned.binding.taskId).toBe("task:42");
    expect(spawned.binding.accessDomainId).toBe("domain:workcell");
    expect(spawned.binding.runtimeProfile).toBe("wasmtime");
    expect(spawned.binding.authorityGeneration).toBe(3);
    expect(spawned.principalId).not.toEqual(orchestrator.principalId);
    expect(spawned.actorInstanceId).toContain(spawned.principalId);
  });

  it("refuses unsupported native runtimes without minting a principal", () => {
    expect(() => refuseUnsupportedWorkloadRuntime("native_oci")).toThrow(
      /unsupported workload runtime/,
    );
    expect(() =>
      spawnWorkloadIdentity({
        orchestrator,
        taskId: "task:42",
        accessDomainId: "domain:workcell",
        runtimeProfile: "native_oci",
        authorityGeneration: 1,
        publicKeyJkt: "jkt_spawned1",
        ordinal: 0,
        boundAt: new Date("2026-09-15T00:00:00Z"),
      }),
    ).toThrow(/unsupported workload runtime/);
  });

  it("refuses person orchestrators and restore without generation bump", () => {
    expect(() =>
      spawnWorkloadIdentity({
        orchestrator: {
          kind: "person",
          principalId: "prn_human",
          realmId: "org:1",
        },
        taskId: "task:1",
        accessDomainId: "domain:1",
        runtimeProfile: "wasmtime",
        authorityGeneration: 1,
        publicKeyJkt: "jkt_spawned1",
        ordinal: 0,
        boundAt: new Date("2026-09-15T00:00:00Z"),
      }),
    ).toThrow(/cannot spawn workloads/);

    expect(() =>
      spawnWorkloadIdentity({
        orchestrator,
        taskId: "task:1",
        accessDomainId: "domain:1",
        runtimeProfile: "wasmtime",
        authorityGeneration: 2,
        publicKeyJkt: "jkt_spawned1",
        ordinal: 0,
        boundAt: new Date("2026-09-15T00:00:00Z"),
        restoredFromGeneration: 2,
      }),
    ).toThrow(/newer authorityGeneration/);
  });
});
