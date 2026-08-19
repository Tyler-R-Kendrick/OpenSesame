import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_TASKBUS_RESPONSE_KEYS,
  GetTaskBusResponseSchema,
  PingTaskBusResponseSchema,
  PutTaskBusRequestSchema,
  PutTaskBusResponseSchema,
  TaskBusConfigSchema,
} from "../taskbus.js";

const sampleConfig = {
  backend: "nats" as const,
  nats_url: "nats://127.0.0.1:4222",
  source: "stored" as const,
  status: "ok",
  last_error: null,
};

describe("taskbus contract", () => {
  it("parses operator GET/PUT/PING shapes", () => {
    expect(TaskBusConfigSchema.parse(sampleConfig).backend).toBe("nats");
    expect(
      GetTaskBusResponseSchema.parse({ taskbus: sampleConfig }).taskbus.source,
    ).toBe("stored");
    expect(
      PutTaskBusRequestSchema.parse({
        backend: "nats",
        nats_url: "nats://box.tail.ts.net:4222",
      }).nats_url,
    ).toContain("tail");
    expect(
      PutTaskBusResponseSchema.parse({
        taskbus: sampleConfig,
        applied: true,
      }).applied,
    ).toBe(true);
    expect(
      PingTaskBusResponseSchema.parse({
        ok: true,
        taskbus: { ...sampleConfig, status: "reachable" },
      }).ok,
    ).toBe(true);
  });

  it("rejects http URLs and unknown fields", () => {
    expect(() =>
      PutTaskBusRequestSchema.parse({
        backend: "nats",
        nats_url: "http://127.0.0.1:4222",
      }),
    ).toThrow();
    expect(() =>
      TaskBusConfigSchema.parse({ ...sampleConfig, access_token: "leak" }),
    ).toThrow();
    for (const key of FORBIDDEN_TASKBUS_RESPONSE_KEYS) {
      expect(() =>
        TaskBusConfigSchema.parse({ ...sampleConfig, [key]: "secret" }),
      ).toThrow();
    }
  });

  it("allows memory backend without nats_url", () => {
    expect(
      TaskBusConfigSchema.parse({
        backend: "memory",
        source: "default",
        status: "ok",
      }).backend,
    ).toBe("memory");
  });
});
