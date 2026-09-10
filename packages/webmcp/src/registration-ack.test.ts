import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createWebMcpRegistrar, liveWebMcpToolNames } from "./registrar.js";

const tool = {
  name: "opensesame_ack_test",
  description: "Acknowledgement test",
  inputSchema: { type: "object" },
  execute: () => ({ ok: true }),
};

function pendingRegistration() {
  const resolve = vi.fn<() => void>();
  const reject = vi.fn<(error: Error) => void>();
  const promise = new Promise<void>((accept, refuse) => {
    resolve.mockImplementation(accept);
    reject.mockImplementation(refuse);
  });
  const boundary: BoundaryValue = overlapCast(promise);
  return { promise: boundary, resolve, reject };
}

describe("native registration acknowledgement", () => {
  it("does not claim a pending or refused registration is exposed", async () => {
    const pending = pendingRegistration();
    const onRegistered = vi.fn();
    const onFailure = vi.fn();
    const stop = createWebMcpRegistrar(
      {
        registerTool: () => pending.promise,
      },
      { appId: "test", onRegistered, onFailure },
    ).register([tool]);
    expect(onRegistered).not.toHaveBeenCalled();
    expect(liveWebMcpToolNames()).not.toContain(tool.name);
    pending.reject(new Error("refused"));
    await Promise.resolve();
    expect(onRegistered).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith({
      name: tool.name,
      reason: "refused",
    });
    expect(liveWebMcpToolNames()).not.toContain(tool.name);
    stop();
  });

  it("acknowledges successful registration only after Chrome resolves", async () => {
    const pending = pendingRegistration();
    const onRegistered = vi.fn();
    const stop = createWebMcpRegistrar(
      {
        registerTool: () => pending.promise,
      },
      { appId: "test", onRegistered },
    ).register([tool]);
    expect(onRegistered).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.resolve();
    expect(onRegistered).toHaveBeenCalledExactlyOnceWith(tool.name);
    stop();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a stale %s after cleanup",
    async (settle) => {
      const pending = pendingRegistration();
      const onRegistered = vi.fn();
      const onFailure = vi.fn();
      const stop = createWebMcpRegistrar(
        {
          registerTool: () => pending.promise,
        },
        { appId: "test", onRegistered, onFailure },
      ).register([tool]);
      stop();
      if (settle === "resolve") pending.resolve();
      else pending.reject(new Error("old registration"));
      await Promise.resolve();
      expect(onRegistered).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    },
  );

  it("never unregisters another owner's tool after a duplicate rejection", () => {
    const unregisterTool = vi.fn();
    const stop = createWebMcpRegistrar(
      {
        registerTool: () => {
          throw new Error("duplicate");
        },
        unregisterTool,
      },
      { appId: "test" },
    ).register([tool]);
    stop();
    expect(unregisterTool).not.toHaveBeenCalled();
  });
});
