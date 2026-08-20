import { beforeEach, describe, expect, it, vi } from "vitest";
import { overlapCast, type BoundaryValue } from "@opensesame/os-domain";

const hostFetch = vi.hoisted(() => vi.fn());
import { identitySeams } from "./identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {hostFetch});
import { getTaskBusConfig, pingTaskBus, putTaskBusConfig } from "./taskbus.js";

function jsonResponse(status: number, body: BoundaryValue): Response {
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
    const [, init] = overlapCast(hostFetch.mock.calls[0]);
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
      jsonResponse(403, {
        error: "forbidden",
        hint: "owner or admin role required",
      }),
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

describe("taskbus client errors and defaults", () => {
  beforeEach(() => hostFetch.mockReset());

  it("fills defaults for a sparse config payload", async () => {
    hostFetch.mockResolvedValue(jsonResponse(200, {}));
    await expect(getTaskBusConfig()).resolves.toEqual({
      backend: "memory",
      natsUrl: null,
      source: "default",
      status: "ok",
      lastError: null,
    });
  });

  it("surfaces the hint, then the error, then the status on failed writes", async () => {
    hostFetch.mockResolvedValue(jsonResponse(500, { hint: "NATS is down" }));
    await expect(putTaskBusConfig({ backend: "nats" })).rejects.toThrow(
      /NATS is down/,
    );

    hostFetch.mockResolvedValue(jsonResponse(500, { error: "nats_refused" }));
    await expect(putTaskBusConfig({ backend: "nats" })).rejects.toThrow(
      /nats_refused/,
    );

    hostFetch.mockResolvedValue(jsonResponse(500, {}));
    await expect(putTaskBusConfig({ backend: "memory" })).rejects.toThrow(
      /Could not save TaskBus config \(500\)/,
    );

    hostFetch.mockResolvedValue(new Response("oops", { status: 502 }));
    await expect(getTaskBusConfig()).rejects.toThrow(
      /Could not read TaskBus config \(502\)/,
    );
  });

  it("throws on ping failures other than 422", async () => {
    hostFetch.mockResolvedValue(jsonResponse(500, { hint: "boom" }));
    await expect(pingTaskBus()).rejects.toThrow(/boom/);

    hostFetch.mockResolvedValue(new Response("oops", { status: 503 }));
    await expect(pingTaskBus()).rejects.toThrow(/TaskBus ping failed \(503\)/);
  });
});
