import { TailscaleNativeHTTPConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { expect, it, vi } from "vitest";
import {
  BrowserNodeRequests,
  nativeWorkerOptions,
} from "./controller-requests.js";
import type { HostEvent } from "./protocol.js";
class WorkerPort {
  sent: unknown[] = [];
  postMessage(value: unknown) {
    this.sent.push(value);
  }
}
function fixture(enabled = true) {
  const worker = new WorkerPort();
  let active = true;
  const stop = vi.fn();
  const requests = new BrowserNodeRequests(
    worker,
    () => {
      if (!active) throw new Error("original owner ended");
    },
    () => true,
    () => true,
    stop,
    enabled,
  );
  return {
    worker,
    requests,
    stop,
    withdraw: () => {
      active = false;
    },
  };
}
async function send(
  f: ReturnType<typeof fixture>,
  owner = new AbortController(),
) {
  const port = f.requests.capture(owner.signal);
  const pending = port.fetch("https://api.example.com/item", {
    method: "POST",
    headers: { authorization: "Bearer fixture" },
    body: new Uint8Array([0, 255]),
  });
  await vi.waitFor(() =>
    expect(f.worker.sent).toContainEqual({ kind: "nativeHTTPReady" }),
  );
  f.requests.receive({ kind: "nativeHTTPReady", ready: true });
  await vi.waitFor(() =>
    expect(f.worker.sent).toContainEqual(
      expect.objectContaining({ kind: "nativeHTTP" }),
    ),
  );
  return { pending, port };
}
function response(
  id: number,
  patch: Partial<Extract<HostEvent, { kind: "nativeHTTP" }>["result"]> = {},
): HostEvent {
  return {
    kind: "nativeHTTP",
    id,
    result: {
      status: 201,
      statusText: "Created",
      url: "https://api.example.com/item",
      headers: [["content-type", "application/octet-stream"]],
      body: new Uint8Array([255, 0, 13]),
      ...patch,
    },
  };
}
it("preserves exact binary bodies, explicit headers, result status and URL through the typed original worker boundary", async () => {
  const f = fixture();
  try {
    const { pending } = await send(f);
    expect(f.worker.sent).toContainEqual({
      kind: "nativeHTTP",
      id: 1,
      request: {
        method: "POST",
        url: "https://api.example.com/item",
        headers: [["authorization", "Bearer fixture"]],
        body: new Uint8Array([0, 255]),
      },
    });
    f.requests.receive(response(1));
    const result = await pending;
    expect(result.status).toBe(201);
    expect(result.statusText).toBe("Created");
    expect(result.url).toBe("https://api.example.com/item");
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([
      255, 0, 13,
    ]);
    expect(f.stop).not.toHaveBeenCalled();
  } finally {
    f.requests.close();
  }
});
it.each(["caller", "owner", "close", "wrong-url", "worker-error"])(
  "refuses %s withdrawal/publication without admitting a later result",
  async (reason) => {
    const f = fixture();
    const owner = new AbortController();
    try {
      const { pending, port } = await send(f, owner);
      const rejected = expect(pending).rejects.toThrow();
      if (reason === "caller") owner.abort();
      if (reason === "owner") f.withdraw();
      if (reason === "close") f.requests.close();
      f.requests.receive(
        reason === "worker-error"
          ? { kind: "nativeHTTPError", id: 1 }
          : response(
              1,
              reason === "wrong-url"
                ? { url: "https://other.example/item" }
                : {},
            ),
      );
      await rejected;
      if (reason === "caller" || reason === "close")
        expect(f.worker.sent).toContainEqual({ kind: "cancelHTTP", id: 1 });
      if (["caller", "close", "owner"].includes(reason))
        expect(() => port.assertCurrent()).toThrow();
      expect(f.stop).not.toHaveBeenCalled();
    } finally {
      f.requests.close();
    }
  },
);
it("per-request cancellation preserves the peer node and allows a second original-owner request", async () => {
  const f = fixture();
  try {
    const firstOwner = new AbortController();
    const first = await send(f, firstOwner);
    const rejected = expect(first.pending).rejects.toThrow();
    firstOwner.abort();
    await rejected;
    f.worker.sent.length = 0;
    const second = await send(f);
    expect(f.worker.sent).toContainEqual(
      expect.objectContaining({ kind: "nativeHTTP", id: 2 }),
    );
    f.requests.receive(response(2));
    expect((await second.pending).status).toBe(201);
    expect(f.stop).not.toHaveBeenCalled();
  } finally {
    f.requests.close();
  }
});
it("refuses disabled native HTTPS and false readiness without sending a provider operation", async () => {
  const disabled = fixture(false);
  expect(() => disabled.requests.capture(new AbortController().signal)).toThrow(
    "Configure",
  );
  disabled.requests.close();
  const f = fixture();
  try {
    const pending = f.requests
      .capture(new AbortController().signal)
      .fetch("https://api.example.com/item");
    const rejected = expect(pending).rejects.toThrow("not ready");
    await vi.waitFor(() =>
      expect(f.worker.sent).toContainEqual({ kind: "nativeHTTPReady" }),
    );
    f.requests.receive({ kind: "nativeHTTPReady", ready: false });
    await rejected;
    expect(f.worker.sent).not.toContainEqual(
      expect.objectContaining({ kind: "nativeHTTP" }),
    );
  } finally {
    f.requests.close();
  }
});
it("checks owner changes while awaiting ready and never sends an operation on replacement authority", async () => {
  const f = fixture();
  try {
    const pending = f.requests
      .capture(new AbortController().signal)
      .fetch("https://api.example.com/item");
    const rejected = expect(pending).rejects.toThrow("owner ended");
    await vi.waitFor(() =>
      expect(f.worker.sent).toContainEqual({ kind: "nativeHTTPReady" }),
    );
    f.withdraw();
    f.requests.receive({ kind: "nativeHTTPReady", ready: true });
    await rejected;
    expect(f.worker.sent).not.toContainEqual(
      expect.objectContaining({ kind: "nativeHTTP" }),
    );
  } finally {
    f.requests.close();
  }
});
it.each(["include", "oversized", "integrity", "keepalive"])(
  "refuses unsupported or unbounded %s request before a worker operation",
  async (kind) => {
    const f = fixture();
    try {
      const init: RequestInit =
        kind === "include"
          ? { credentials: "include" }
          : kind === "oversized"
            ? { method: "POST", body: new Uint8Array(1_048_577) }
            : kind === "integrity"
              ? { integrity: "sha256-fixture" }
              : { keepalive: true };
      await expect(
        f.requests
          .capture(new AbortController().signal)
          .fetch("https://api.example.com/item", init),
      ).rejects.toThrow();
      expect(f.worker.sent).not.toContainEqual(
        expect.objectContaining({ kind: "nativeHTTP" }),
      );
    } finally {
      f.requests.close();
    }
  },
);
it("requires this deployment's native asset only for opted-in configurations and drops the persistence version at the worker boundary", () => {
  const base = new URL("https://app.example/OpenSesame/");
  expect(nativeWorkerOptions(undefined, {}, base)).toEqual({
    nativeHTTP: undefined,
    asset: {},
  });
  const config = TailscaleNativeHTTPConfiguration.parse({
    version: 1,
    exitNodeID: "approved-exit",
    trustMode: "public",
    targets: [
      { origin: "https://api.example.com", prefixes: ["203.0.113.0/24"] },
    ],
  });
  const native = structuredClone(config);
  expect(() => nativeWorkerOptions(native, {}, base)).toThrow("missing");
  expect(
    nativeWorkerOptions(
      native,
      { nativeHTTP: "tailscale/native-fixture.js" },
      base,
    ),
  ).toEqual({
    nativeHTTP: {
      exitNodeID: "approved-exit",
      trustMode: "public",
      targets: native.targets,
    },
    asset: {
      nativeHTTP: "https://app.example/OpenSesame/tailscale/native-fixture.js",
    },
  });
});
