import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createNativeImplicitReceiver,
  deliverNativeImplicitPayload,
} from "./native-implicit-session.js";
const origin = "https://selfhost.example";
const redirectUri = `${origin}/auth/native-implicit.html`;
const peers = new Set<Channel>();
const wire: BoundaryValue[] = [];
class Channel {
  onmessage:
    | ((event: Pick<MessageEvent<BoundaryValue>, "data">) => void)
    | null = null;
  constructor(readonly name: string) {
    peers.add(this);
  }
  postMessage(data: BoundaryValue) {
    wire.push(data);
    for (const peer of peers)
      if (peer !== this && peer.name === this.name)
        queueMicrotask(() => peer.onmessage?.({ data }));
  }
  close() {
    peers.delete(this);
    this.onmessage = null;
  }
}
const payload = {
  accessToken: "actual-observed-minted-token",
  tokenType: "Bearer",
  expiresIn: 3600,
  scopes: ["identify"],
};
beforeEach(() => {
  vi.stubGlobal("window", { location: new URL(origin) });
  vi.stubGlobal("BroadcastChannel", Channel);
  wire.length = 0;
});
afterEach(() => {
  for (const peer of peers) peer.close();
  vi.unstubAllGlobals();
});
async function receiver() {
  return createNativeImplicitReceiver({
    providerId: "discord",
    redirectUri,
    nonce: "n".repeat(43),
  });
}
it("retains the minted credential durably before acknowledging delivery", async () => {
  const session = await receiver();
  let release: () => void = () => undefined;
  const durable = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retain = vi.fn(async () => durable);
  const waiting = session.wait({ expiresAt: Date.now() + 60_000, retain });
  const delivering = deliverNativeImplicitPayload(
    session.state,
    "discord",
    redirectUri,
    payload,
  );
  await vi.waitFor(() => expect(retain).toHaveBeenCalledWith(payload));
  // The delivery envelope and the receiver's pre-retention receipt.
  expect(wire).toHaveLength(2);
  expect(JSON.stringify(wire)).not.toContain(payload.accessToken);
  release();
  await expect(waiting).resolves.toEqual(payload);
  await delivering;
  expect(wire).toHaveLength(3);
  expect(peers.size).toBe(0);
});
it("returns retained bearer material after cancellation during durable journaling", async () => {
  const session = await receiver();
  const abort = new AbortController();
  let release: () => void = () => undefined;
  const durable = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retain = vi.fn(async () => durable);
  const waiting = session.wait({
    expiresAt: Date.now() + 60_000,
    signal: abort.signal,
    retain,
  });
  const delivering = deliverNativeImplicitPayload(
    session.state,
    "discord",
    redirectUri,
    payload,
  );
  await vi.waitFor(() => expect(retain).toHaveBeenCalled());
  abort.abort();
  release();
  await expect(waiting).resolves.toEqual(payload);
  await delivering;
});
it("clamps a wall-clock step-back instead of rejecting a just-minted window", async () => {
  const session = await receiver();
  const now = Date.now();
  const spy = vi.spyOn(Date, "now").mockReturnValue(now - 1);
  try {
    const waiting = session.wait({
      expiresAt: now + 600_000,
      retain: async () => undefined,
    });
    session.close();
    await expect(waiting).rejects.toThrow(/cancelled|expired/i);
  } finally {
    spy.mockRestore();
  }
});

it("does not fail delivery while the receiver is still retaining", async () => {
  vi.useFakeTimers();
  try {
    const session = await receiver();
    let release: () => void = () => undefined;
    const durable = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retain = vi.fn(async () => durable);
    const waiting = session.wait({
      expiresAt: Date.now() + 600_000,
      retain,
    });
    const delivering = deliverNativeImplicitPayload(
      session.state,
      "discord",
      redirectUri,
      payload,
    );
    let settled = false;
    void delivering.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(retain).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting).resolves.toEqual(payload);
    await delivering;
  } finally {
    vi.useRealTimers();
  }
});

it("acknowledges encrypted denial without retaining credentials", async () => {
  const session = await receiver();
  const retain = vi.fn(async () => undefined);
  const waiting = expect(
    session.wait({ expiresAt: Date.now() + 60_000, retain }),
  ).rejects.toThrow("declined");
  await deliverNativeImplicitPayload(session.state, "discord", redirectUri, {
    error: true,
  });
  await waiting;
  expect(retain).not.toHaveBeenCalled();
});
it("preserves malformed observed grants for cleanup rather than discarding their bearer", async () => {
  const session = await receiver();
  const malformed = {
    ...payload,
    tokenType: "unexpected",
    expiresIn: null,
    scopes: null,
    protocolValid: false,
  };
  const retain = vi.fn(async () => undefined);
  const waiting = session.wait({ expiresAt: Date.now() + 60_000, retain });
  await deliverNativeImplicitPayload(
    session.state,
    "discord",
    redirectUri,
    malformed,
  );
  await expect(waiting).resolves.toEqual(malformed);
  expect(retain).toHaveBeenCalledWith(malformed);
});
it("cleans the receiver when cancellation happens before any grant exists", async () => {
  const session = await receiver();
  const abort = new AbortController();
  const waiting = expect(
    session.wait({
      expiresAt: Date.now() + 60_000,
      signal: abort.signal,
      retain: async () => undefined,
    }),
  ).rejects.toThrow("cancelled");
  abort.abort();
  await waiting;
  expect(peers.size).toBe(0);
});
it("refuses a same-origin peer's publicly forged delivery acknowledgement", async () => {
  const session = await receiver();
  let release: () => void = () => undefined;
  const durable = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retain = vi.fn(async () => durable);
  const waiting = session.wait({ expiresAt: Date.now() + 60000, retain });
  let acknowledged = false;
  const delivery = deliverNativeImplicitPayload(
    session.state,
    "discord",
    redirectUri,
    payload,
  ).then(() => {
    acknowledged = true;
  });
  await vi.waitFor(() => expect(retain).toHaveBeenCalled());
  const posted = z.object({ ciphertext: z.string() }).parse(wire[0]);
  const publicDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(posted.ciphertext),
  );
  const forged = btoa(String.fromCharCode(...new Uint8Array(publicDigest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const peer = [...peers][0];
  if (!peer) throw new Error("Missing receiver");
  peer.postMessage({ kind: "accepted", receipt: forged });
  await Promise.resolve();
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  release();
  await waiting;
  await delivery;
  expect(acknowledged).toBe(true);
});
