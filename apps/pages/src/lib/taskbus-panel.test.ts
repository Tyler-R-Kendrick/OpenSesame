import {
  GetTaskBusResponseSchema,
  PingTaskBusResponseSchema,
  PutTaskBusResponseSchema,
} from "@opensesame/contracts";
import { describe, expect, it } from "vitest";
import {
  taskBusControlsDisabled,
  taskBusEnvOverrideNotice,
  taskBusPingFlash,
  taskBusSaveFlash,
  taskBusShowNatsUrlField,
  taskBusStatusTone,
} from "./taskbus-panel.js";

describe("taskbus panel logic", () => {
  const stored: Parameters<typeof taskBusSaveFlash>[1] = {
    backend: "nats",
    natsUrl: "nats://127.0.0.1:4222",
    source: "stored",
    status: "ok",
    lastError: null,
  };

  it("disables controls when env overrides or busy", () => {
    expect(taskBusControlsDisabled(stored, false)).toBe(false);
    expect(taskBusControlsDisabled({ ...stored, source: "env" }, false)).toBe(
      true,
    );
    expect(taskBusControlsDisabled(stored, true)).toBe(true);
  });

  it("derives save and ping flash copy", () => {
    expect(taskBusSaveFlash(true, stored).tone).toBe("ok");
    expect(
      taskBusSaveFlash(false, { ...stored, lastError: "refused" }).text,
    ).toMatch(/refused/);
    expect(taskBusPingFlash(true, stored).tone).toBe("ok");
    expect(
      taskBusPingFlash(false, { ...stored, lastError: "timeout" }).tone,
    ).toBe("err");
  });

  it("shows NATS field and env notice appropriately", () => {
    expect(taskBusShowNatsUrlField("memory")).toBe(false);
    expect(taskBusShowNatsUrlField("nats")).toBe(true);
    expect(taskBusEnvOverrideNotice("env")).toBe(true);
    expect(taskBusEnvOverrideNotice("stored")).toBe(false);
    expect(taskBusStatusTone({ ...stored, status: "fail" })).toBe("warn");
  });
});

describe("taskbus wire contract (pages consumer)", () => {
  it("validates Host responses the panel consumes", () => {
    const get = GetTaskBusResponseSchema.parse({
      taskbus: {
        backend: "memory",
        source: "default",
        status: "ok",
      },
    });
    expect(get.taskbus.backend).toBe("memory");

    const put = PutTaskBusResponseSchema.parse({
      applied: false,
      taskbus: {
        backend: "nats",
        nats_url: "nats://127.0.0.1:4222",
        source: "stored",
        status: "stored_reconnect_failed",
        last_error: "connection refused",
      },
    });
    expect(put.taskbus.last_error).toMatch(/refused/);

    const ping = PingTaskBusResponseSchema.parse({
      ok: false,
      taskbus: {
        backend: "nats",
        nats_url: "nats://127.0.0.1:4222",
        source: "stored",
        status: "unreachable",
        last_error: "timeout",
      },
    });
    expect(ping.ok).toBe(false);
  });
});
