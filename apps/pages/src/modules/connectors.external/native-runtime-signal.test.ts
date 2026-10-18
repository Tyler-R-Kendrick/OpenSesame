import { once } from "node:events";
import { type ServerResponse, createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { nativeDeviceViewSeams } from "@opensesame/app-core/lib/device-connector-view.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeRuntime } from "./native-runtime.js";

const initialProjector = nativeDeviceViewSeams.authorization;
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dispose.splice(0).reverse()) cleanup();
  nativeDeviceViewSeams.authorization = initialProjector;
});

function bindActualTransport() {
  const test = createTestContext();
  const ctx = {
    ...test.ctx,
    egress: {
      ...test.ctx.egress,
      fetch: (input: string | URL, init?: RequestInit) => fetch(input, init),
    },
  };
  const activation = createActivation(ctx, "connectors.external");
  dispose.push(() => activation.dispose());
  bindNativeRuntime(ctx, activation);
  const transport = nativeProviderTransport();
  const signal = transport.signal;
  if (!signal)
    throw new Error("Native runtime did not expose its captured signal");
  return { test, activation, transport, signal };
}

async function httpFixture() {
  const sockets = new Set<Socket>();
  let held: ServerResponse | undefined;
  let premature = false;
  let resolveStarted = () => {};
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url === "/complete") {
      response.end("complete");
      return;
    }
    held = response;
    response.on("close", () => {
      premature = !response.writableEnded;
    });
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("prefix");
    resolveStarted();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // A listening TCP server reports AddressInfo, never a pipe address.
  const address: AddressInfo = overlapCast(server.address());
  const { port } = address;
  return {
    origin: `http://127.0.0.1:${port}`,
    started,
    premature: () => premature,
    finish: () => {
      if (!held) throw new Error("No actual held response");
      held.end("suffix");
    },
    close: async () => {
      const stopped = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      const closed = [...sockets].map((socket) => once(socket, "close"));
      server.closeAllConnections();
      await Promise.all([stopped, ...closed]);
      expect(sockets.size).toBe(0);
    },
  };
}

describe("captured native provider signal", () => {
  it.each(["lease", "dispose", "replacement"] as const)(
    "closes an actual held HTTP body when its original %s owner ends",
    async (withdraw) => {
      const owner = bindActualTransport();
      const fixture = await httpFixture();
      try {
        const response = await fetch(`${fixture.origin}/hold`, {
          signal: owner.signal,
        });
        await fixture.started;
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No actual HTTP body");
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(
          "prefix",
        );
        const pending = reader.read();
        const rejection = expect(pending).rejects.toMatchObject({
          name: "AbortError",
        });
        let replacement: ReturnType<typeof bindActualTransport> | undefined;
        if (withdraw === "replacement") {
          replacement = bindActualTransport();
          expect(owner.transport.signal).toBe(owner.signal);
          expect(owner.signal).not.toBe(replacement.signal);
        }
        if (withdraw === "dispose") owner.activation.dispose();
        else owner.test.abort("original owner withdrawn");
        await rejection;
        expect(owner.signal.aborted).toBe(true);
        expect(() => owner.transport.assertCurrent()).toThrow();
        await expect.poll(fixture.premature).toBe(true);
        if (replacement) {
          expect(nativeProviderTransport()).toBe(replacement.transport);
          expect(replacement.signal.aborted).toBe(false);
          replacement.transport.assertCurrent();
          const next = await replacement.transport.fetch(
            `${fixture.origin}/complete`,
          );
          expect(await next.text()).toBe("complete");
          expect(replacement.signal.aborted).toBe(false);
          expect(owner.transport.signal).toBe(owner.signal);
        }
      } finally {
        owner.activation.dispose();
        await fixture.close();
      }
    },
  );

  it("keeps a completed HTTP read live until that same activation ends", async () => {
    const owner = bindActualTransport();
    const fixture = await httpFixture();
    try {
      const response = await owner.transport.fetch(
        `${fixture.origin}/complete`,
        {
          signal: owner.signal,
        },
      );
      expect(await response.text()).toBe("complete");
      expect(owner.signal.aborted).toBe(false);
      owner.transport.assertCurrent();
      owner.activation.dispose();
      expect(owner.signal.aborted).toBe(true);
      expect(owner.transport.signal).toBe(owner.signal);
    } finally {
      owner.activation.dispose();
      await fixture.close();
    }
  });

  it("allows an already submitted credential mutation to settle after signal withdrawal", async () => {
    const owner = bindActualTransport();
    const fixture = await httpFixture();
    try {
      const mutation = owner.transport.settleCredentialMutation;
      if (!mutation) throw new Error("Missing compensation transport");
      const response = await mutation(`${fixture.origin}/hold`, {
        method: "POST",
      });
      await fixture.started;
      const body = response.text();
      owner.activation.dispose();
      expect(owner.signal.aborted).toBe(true);
      fixture.finish();
      expect(await body).toBe("prefixsuffix");
      expect(fixture.premature()).toBe(false);
      await expect(mutation(`${fixture.origin}/complete`)).rejects.toThrow();
    } finally {
      owner.activation.dispose();
      await fixture.close();
    }
  });
});
