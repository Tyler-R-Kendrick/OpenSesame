import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import {
  EVENT_ROTATION_FAILED,
  EVENT_ROTATION_REQUESTED,
  EVENT_ROTATION_SUCCEEDED,
  InMemoryTaskBus,
  assertNoSecrets,
  consumeRotationEvents,
  toPublicJobView,
} from "../rotation.js";

describe("toPublicJobView", () => {
  it("maps top-level fallbacks when there is no target block", () => {
    const view = toPublicJobView({
      id: "rot_fallback",
      status: "succeeded",
      connection_id: "connection:top",
      store_path: "stores/a",
      project_id: "proj_1",
      organization_id: "org_1",
      error: "partial",
    });

    expect(view).toEqual({
      id: "rot_fallback",
      status: "succeeded",
      connectionId: "connection:top",
      storePath: "stores/a",
      projectId: "proj_1",
      organizationId: "org_1",
      error: "partial",
      secretsReturned: false,
    });
  });

  it("prefers target fields over top-level ones", () => {
    const view = toPublicJobView({
      rotation_id: "rot_target",
      connection_id: "connection:top",
      store_path: "stores/top",
      target: { connection_id: "connection:nested", path: "stores/nested" },
    });

    expect(view.connectionId).toBe("connection:nested");
    expect(view.storePath).toBe("stores/nested");
  });

  it("defaults an unknown status to requested and an absent id to empty", () => {
    const view = toPublicJobView({ status: "weird" });
    expect(view.status).toBe("requested");
    expect(view.id).toBe("");
    expect(view.connectionId).toBeUndefined();
    expect(view.storePath).toBeUndefined();
  });

  it("rejects secret-shaped keys case-insensitively", () => {
    expect(() => assertNoSecrets({ Password: "x" })).toThrow(/Password/);
    expect(() => assertNoSecrets({ note: "fine" })).not.toThrow();
  });
});

describe("consumeRotationEvents — edge cases", () => {
  it("ignores events that are not rotation events", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({ id: "evt_other", type: "principal.created", data: {} });
    await bus.publish({
      id: "evt_rot",
      type: EVENT_ROTATION_SUCCEEDED,
      data: { rotation_id: "rot_1", status: "succeeded" },
    });

    const result = await consumeRotationEvents({ bus });
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.jobs[0]?.id).toBe("rot_1");
  });

  it("records succeeded and failed notifications as views only", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({
      id: "evt_ok",
      type: EVENT_ROTATION_SUCCEEDED,
      data: { rotation_id: "rot_ok", status: "succeeded" },
    });
    await bus.publish({
      id: "evt_bad",
      type: EVENT_ROTATION_FAILED,
      data: { rotation_id: "rot_bad", status: "failed", error: "host down" },
    });
    const execute = vi.fn();

    const result = await consumeRotationEvents({
      bus,
      executeConnectionRotation: execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.jobs[1]?.error).toBe("host down");
  });

  it("records a requested rotation without executing when no connection is named", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({
      id: "evt_noconn",
      type: EVENT_ROTATION_REQUESTED,
      data: { rotation_id: "rot_noconn" },
    });
    const execute = vi.fn();

    const result = await consumeRotationEvents({
      bus,
      executeConnectionRotation: execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.processed).toBe(1);
    expect(result.jobs[0]?.status).toBe("requested");
  });

  it("records a requested rotation as-is when no executor is wired", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({
      id: "evt_noexec",
      type: EVENT_ROTATION_REQUESTED,
      data: {
        rotation_id: "rot_noexec",
        target: { connection_id: "connection:1" },
      },
    });

    const result = await consumeRotationEvents({ bus });
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.jobs[0]?.connectionId).toBe("connection:1");
  });

  it("counts an executor-reported failure without re-publishing", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({
      id: "evt_softfail",
      type: EVENT_ROTATION_REQUESTED,
      data: {
        rotation_id: "rot_soft",
        target: { connection_id: "connection:1" },
      },
    });

    const result = await consumeRotationEvents({
      bus,
      executeConnectionRotation: async ({ rotationId }) => ({
        id: rotationId,
        status: "failed",
        error: "upstream refused",
        secretsReturned: false,
      }),
    });

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.jobs[0]?.status).toBe("failed");
    // The executor answered cleanly, so the consumer does not synthesize a
    // follow-up failure event for it.
    expect(await bus.drain(10)).toHaveLength(0);
  });

  it("fails a rotation whose executor tries to hand back secrets", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({
      id: "evt_leak",
      type: EVENT_ROTATION_REQUESTED,
      data: {
        rotation_id: "rot_leak",
        organization_id: "org_1",
        target: { connection_id: "connection:1" },
      },
    });
    const logs: string[] = [];

    const result = await consumeRotationEvents({
      bus,
      executeConnectionRotation: async ({ rotationId }) =>
        overlapCast({
          id: rotationId,
          status: "succeeded",
          secretsReturned: true,
        }),
      log: (msg) => logs.push(msg),
    });

    expect(result.failed).toBe(1);
    expect(result.jobs[0]?.secretsReturned).toBe(false);
    expect(logs[0]).toContain("rotation execute failed");

    const followUps = await bus.drain(10);
    const failure = followUps.find((e) => e.type === EVENT_ROTATION_FAILED);
    expect(failure?.data.rotation_id).toBe("rot_leak");
    expect(failure?.data.organization_id).toBe("org_1");
  });

  it("fails a rotation whose executor returns a forbidden field", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({
      id: "evt_field",
      type: EVENT_ROTATION_REQUESTED,
      data: {
        rotation_id: "rot_field",
        target: { connection_id: "connection:1" },
      },
    });

    const result = await consumeRotationEvents({
      bus,
      executeConnectionRotation: async ({ rotationId }) =>
        overlapCast({
          id: rotationId,
          status: "succeeded",
          secretsReturned: false,
          access_token: "leak",
        }),
    });

    expect(result.failed).toBe(1);
    expect(result.jobs[0]?.error).toMatch(/access_token/);
  });

  it("stringifies non-Error executor failures", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({
      id: "evt_str",
      type: EVENT_ROTATION_REQUESTED,
      data: {
        rotation_id: "rot_str",
        target: { connection_id: "connection:1" },
      },
    });
    const failure = "plain string failure";

    const result = await consumeRotationEvents({
      bus,
      executeConnectionRotation: async () => {
        throw failure;
      },
    });

    expect(result.failed).toBe(1);
    expect(result.jobs[0]?.error).toBe("plain string failure");
  });

  it("drains at most max events per call", async () => {
    const bus = new InMemoryTaskBus();
    for (let i = 0; i < 3; i += 1) {
      await bus.publish({
        id: `evt_${i}`,
        type: EVENT_ROTATION_SUCCEEDED,
        data: { rotation_id: `rot_${i}`, status: "succeeded" },
      });
    }

    const first = await consumeRotationEvents({ bus }, 2);
    expect(first.processed).toBe(2);
    const second = await consumeRotationEvents({ bus }, 2);
    expect(second.processed).toBe(1);
  });
});
