import { beforeEach, describe, expect, it, vi } from "vitest";

const hostFetch = vi.hoisted(() => vi.fn());
vi.mock("./identity.js", () => ({ hostFetch }));

import { getTaskBusConfig, putTaskBusConfig, pingTaskBus } from "./taskbus.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("taskbus client", () => {
  beforeEach(() => hostFetch.mockReset());

  it("reads Host TaskBus config", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, {
        taskbus: {
          backend: "nats",
          nats_url: "nats://127.0.0.1:4222",
          source: "stored",
          status: "ok",
          last_error: null,
        },
      }),
    );
    const cfg = await getTaskBusConfig();
    expect(cfg.backend).toBe("nats");
    expect(cfg.natsUrl).toBe("nats://127.0.0.1:4222");
  });

  it("puts snake_case wire fields", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, {
        applied: true,
        taskbus: {
          backend: "nats",
          nats_url: "nats://box.tail.ts.net:4222",
          source: "stored",
          status: "applied",
        },
      }),
    );
    await putTaskBusConfig({
      backend: "nats",
      natsUrl: "nats://box.tail.ts.net:4222",
    });
    const [, init] = hostFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).nats_url).toContain("tail");
  });

  it("pings via Host network", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        taskbus: { backend: "memory", source: "default", status: "reachable" },
      }),
    );
    const result = await pingTaskBus();
    expect(result.ok).toBe(true);
  });

  it("surfaces Host errors from failed get", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(403, { error: "forbidden", hint: "owner or admin role required" }),
    );
    await expect(getTaskBusConfig()).rejects.toThrow(/owner or admin/);
  });

  it("treats ping 422 as unreachable without throwing", async () => {
    hostFetch.mockResolvedValue(
      jsonResponse(422, {
        ok: false,
        taskbus: {
          backend: "nats",
          nats_url: "nats://missing:4222",
          source: "stored",
          status: "unreachable",
          last_error: "connection refused",
        },
      }),
    );
    const result = await pingTaskBus();
    expect(result.ok).toBe(false);
    expect(result.config.lastError).toMatch(/refused/);
  });
});
