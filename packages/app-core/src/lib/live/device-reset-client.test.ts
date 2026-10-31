import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceClient, DeviceError, type DevicePipe } from "./device-client.js";
import type { DeviceMessage, DeviceRequest } from "./device-messages.js";
import type { DeviceResetRequest } from "./device-reset-messages.js";
import { FAKE_CLOCK } from "./live-clock.fixture.js";

function pipe() {
  const sent: DeviceRequest[] = [];
  let hear: (message: DeviceMessage) => void = () => undefined;
  const made: DevicePipe = {
    send: (request) => {
      sent.push(request);
      return true;
    },
    onMessage: (handler) => {
      hear = handler;
    },
    onEnd: () => undefined,
  };
  return { made, sent, reply: (message: DeviceMessage) => hear(message) };
}

beforeEach(() => vi.useFakeTimers({ ...FAKE_CLOCK, now: 1_800_000_000_000 }));
afterEach(() => vi.useRealTimers());

describe("device reset client", () => {
  it("keeps the caller's stable request id and validates the returned grant", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made);
    const pending = client.reset("stable-request", {
      origin: "https://accounts.example.test",
      item: "item-1",
      runtime: "agent-browser",
      model: "decision-model",
      expiresAt: Date.now() + 60_000,
      actions: ["password_reset.item.use"],
    });
    await vi.waitFor(() => expect(owner.sent).toHaveLength(1));
    // SAFETY: reset() sends exactly one DeviceResetRequest through this fixture pipe.
    const request = owner.sent[0] as DeviceResetRequest;
    expect(request.req).toBe("stable-request");
    owner.reply({
      t: "dev.reset.grant",
      req: request.req,
      grant: "reset-stable-request",
      origin: request.origin,
      item: request.item,
      runtime: request.runtime,
      model: request.model,
      expiresAt: request.expiresAt,
      actions: request.actions,
      digest: request.digest,
    });
    await expect(pending).resolves.toMatchObject({
      grant: "reset-stable-request",
    });
    client.close();
  });

  it("refuses a grant from another request or action", async () => {
    const owner = pipe();
    const client = new DeviceClient(owner.made);
    const pending = client.reset("stable-request", {
      origin: "https://accounts.example.test",
      item: "item-1",
      runtime: "agent-browser",
      model: "decision-model",
      expiresAt: Date.now() + 60_000,
      actions: ["password_reset.item.use"],
    });
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(owner.sent).toHaveLength(1));
    // SAFETY: reset() sends exactly one DeviceResetRequest through this fixture pipe.
    const request = owner.sent[0] as DeviceResetRequest;
    owner.reply({
      t: "dev.reset.grant",
      req: request.req,
      grant: "forged-grant",
      origin: request.origin,
      item: request.item,
      runtime: request.runtime,
      model: request.model,
      expiresAt: request.expiresAt,
      actions: request.actions,
      digest: request.digest,
    });
    await expect(pending).rejects.toBeInstanceOf(DeviceError);
    client.close();
  });
});
