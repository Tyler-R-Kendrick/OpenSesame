import type { BoundaryValue } from "@opensesame/os-domain";
import { type Mock, afterEach, beforeEach, expect, it, vi } from "vitest";
import { signInLocalBrowser } from "./local-browser.js";
import { parseLocalAuthorizationRequest } from "./local-protocol.js";

// The popup can stop answering without the relying party being told: the
// issuer page drops the transferred port during a remount, navigates away or
// crashes. These cases must fail within seconds, never at the 300 s deadline,
// and every exit must leave no timer or listener behind.
const origin = "https://issuer.example.test";
const clientId = "local_00000000-0000-4000-8000-000000000001";
type PopupFixture = {
  closed: boolean;
  close: () => void;
  location: { replace: (url: string) => void };
  postMessage: Mock<
    (message: BoundaryValue, origin: string, ports: MessagePort[]) => void
  >;
};
type Outcome =
  | { value: Awaited<ReturnType<typeof signInLocalBrowser>> }
  | { error: Error };
// Captured before any test fakes timers: port delivery is a real event-loop turn.
const realImmediate = globalThis.setImmediate;
let browser: EventTarget;
let popup: PopupFixture;
let target: string;
let listeners: Map<string, number>;

beforeEach(() => {
  vi.useFakeTimers();
  target = "";
  listeners = new Map();
  popup = {
    closed: false,
    close: () => {
      popup.closed = true;
    },
    location: {
      replace: (url) => {
        target = url;
      },
    },
    postMessage: vi.fn(),
  };
  const events = new EventTarget();
  browser = Object.assign(events, {
    open: () => popup,
    addEventListener: (type: string, listener: EventListener) => {
      listeners.set(type, (listeners.get(type) ?? 0) + 1);
      EventTarget.prototype.addEventListener.call(events, type, listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.set(type, (listeners.get(type) ?? 0) - 1);
      EventTarget.prototype.removeEventListener.call(events, type, listener);
    },
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("location", { origin: "https://rp.example.test" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open() {
  let settled: Outcome | null = null;
  const result = signInLocalBrowser({
    authorizationEndpoint: `${origin}/identity/authorize`,
    clientId,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
  }).then(
    (value): Outcome => ({ value }),
    (error: Error): Outcome => ({ error }),
  );
  void result.then((outcome) => {
    settled = outcome;
  });
  await vi.waitFor(() => expect(target).not.toBe(""));
  const request = parseLocalAuthorizationRequest(new URL(target).search);
  return { result, request, settled: () => settled };
}

async function connected(version: string | null = "1") {
  const opened = await open();
  const data: Record<string, string> = {
    type: "opensesame:local:ready",
    state: opened.request.state,
  };
  if (version !== null) data.version = version;
  browser.dispatchEvent(
    Object.assign(new Event("message"), { source: popup, origin, data }),
  );
  const call = popup.postMessage.mock.calls[0];
  const port = call?.[2][0];
  if (!port) throw new Error("Missing transferred port");
  return { ...opened, port, connect: call[0] };
}

async function acknowledge(port: MessagePort, state: string) {
  port.postMessage({ type: "connected", state, version: "1" });
  for (let turn = 0; turn < 2; turn++)
    await new Promise((resolve) => realImmediate(resolve));
}

async function signIn(port: MessagePort, state: string, nonce: string) {
  const redeem = new Promise<MessageEvent>((resolve) => {
    port.onmessage = resolve;
  });
  port.postMessage({ type: "code", state, code: "c".repeat(43) });
  const message = await redeem;
  const now = Date.now();
  port.postMessage({
    type: "identity",
    state,
    id: message.data.id,
    issuer: origin,
    audience: clientId,
    sub: "local_00000000-0000-4000-8000-000000000002",
    nonce,
    scope: "openid",
    authTime: String(now),
    expiresAt: String(now + 60_000),
  });
}

function assertTornDown() {
  expect(vi.getTimerCount()).toBe(0);
  expect(listeners.get("message")).toBe(0);
  expect(listeners.get("pagehide")).toBe(0);
  expect(popup.closed).toBe(true);
}

it("rejects promptly when the popup closes before connect", async () => {
  const { result, settled } = await open();
  popup.closed = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled()).toMatchObject({ error: { message: "popup_closed" } });
  expect(await result).toMatchObject({ error: { message: "popup_closed" } });
  assertTornDown();
});

it("rejects promptly when the popup closes after connect but before the result", async () => {
  const { result, port, request, settled } = await connected();
  await acknowledge(port, request.state);
  popup.closed = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled()).toMatchObject({ error: { message: "popup_closed" } });
  await result;
  assertTornDown();
  port.close();
});

it("rejects at the handshake deadline, not at 300 s, when connect goes unanswered", async () => {
  const { result, port, connect, settled } = await connected();
  expect(connect).toMatchObject({
    type: "opensesame:local:connect",
    version: "1",
  });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(settled()).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled()).toMatchObject({
    error: { message: "local_handshake_timeout" },
  });
  await result;
  assertTornDown();
  port.close();
});

it("refuses a first message that is not the acknowledgement", async () => {
  const { result, port, request } = await connected();
  port.postMessage({
    type: "code",
    state: request.state,
    code: "c".repeat(43),
  });
  expect(await result).toMatchObject({
    error: { message: "invalid_response" },
  });
  assertTornDown();
  port.close();
});

it("signs in after the acknowledgement and clears every timer on close", async () => {
  const { result, port, request } = await connected();
  await acknowledge(port, request.state);
  await signIn(port, request.state, request.nonce);
  const outcome = await result;
  if (!("value" in outcome)) throw outcome.error;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(popup.closed).toBe(false);
  outcome.value.close();
  assertTornDown();
  port.close();
});

it("tolerates an issuer that announces no channel version", async () => {
  const { result, port, request, settled } = await connected(null);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled()).toBeNull();
  await signIn(port, request.state, request.nonce);
  const outcome = await result;
  if (!("value" in outcome)) throw outcome.error;
  outcome.value.close();
  assertTornDown();
  port.close();
});

it.each([
  [
    "an issuer error",
    { type: "error", error: "x" },
    "authorization_unavailable",
  ],
  ["an issuer close", { type: "closed" }, "local_session_closed"],
])("clears every timer after %s", async (_name, message, reason) => {
  const { result, port, request } = await connected();
  await acknowledge(port, request.state);
  port.postMessage({ ...message, state: request.state });
  expect(await result).toMatchObject({ error: { message: reason } });
  assertTornDown();
  port.close();
});

it("clears every timer at the overall deadline", async () => {
  const { result, port, request } = await connected();
  await acknowledge(port, request.state);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await result).toMatchObject({
    error: { message: "authorization_expired" },
  });
  assertTornDown();
  port.close();
});
