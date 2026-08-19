import { describe, expect, it } from "vitest";
import {
  EVENT_ROTATION_FAILED,
  EVENT_ROTATION_REQUESTED,
  EVENT_ROTATION_SUCCEEDED,
  InMemoryTaskBus,
  consumeRotationEvents,
  toPublicJobView,
} from "../rotation.js";

describe("rotation consumer", () => {
  it("exposes frozen event type strings", () => {
    expect(EVENT_ROTATION_REQUESTED).toBe("credential.rotation.requested");
    expect(EVENT_ROTATION_SUCCEEDED).toBe("credential.rotation.succeeded");
    expect(EVENT_ROTATION_FAILED).toBe("credential.rotation.failed");
  });

  it("rejects secret-shaped payloads", () => {
    expect(() =>
      toPublicJobView({
        rotation_id: "rot_1",
        status: "requested",
        access_token: "leak",
      }),
    ).toThrow(/access_token/);
  });

  it("consumes requested events and never returns secrets", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({
      id: "evt_1",
      type: EVENT_ROTATION_REQUESTED,
      data: {
        rotation_id: "rot_1",
        status: "requested",
        organization_id: "org:1",
        target: { connection_id: "connection:1" },
      },
    });

    const result = await consumeRotationEvents({
      bus,
      executeConnectionRotation: async ({ rotationId, connectionId }) => ({
        id: rotationId,
        status: "succeeded",
        connectionId,
        secretsReturned: false,
      }),
    });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.jobs[0]?.secretsReturned).toBe(false);
    expect(JSON.stringify(result.jobs)).not.toMatch(
      /access_token|"password"|"secret"|refresh_token|api_key/,
    );
  });

  it("records failed executions without secret fields", async () => {
    const bus = new InMemoryTaskBus();
    await bus.publish({
      id: "evt_2",
      type: EVENT_ROTATION_REQUESTED,
      data: {
        rotation_id: "rot_2",
        status: "requested",
        target: { connection_id: "connection:2" },
      },
    });

    const result = await consumeRotationEvents({
      bus,
      executeConnectionRotation: async () => {
        throw new Error("not refreshable");
      },
    });

    expect(result.failed).toBe(1);
    expect(result.jobs[0]?.status).toBe("failed");
    expect(result.jobs[0]?.secretsReturned).toBe(false);

    const followUps = await bus.drain(10);
    expect(followUps.some((e) => e.type === EVENT_ROTATION_FAILED)).toBe(true);
    expect(JSON.stringify(followUps)).not.toMatch(
      /access_token|"password"|"secret"|refresh_token|api_key/,
    );
  });
});
