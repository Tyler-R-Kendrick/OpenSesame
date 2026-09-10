import type { BoundaryValue } from "@opensesame/os-domain";
import { type Mock, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLocalAgentKey,
  verifyLocalAgentChallenge,
} from "./local-agent.js";
import {
  type LocalBrowserProfile,
  signInLocalBrowser,
} from "./local-browser.js";
import { parseLocalAuthorizationRequest } from "./local-protocol.js";

const origin = "https://issuer.example.test";
const clientId = "local_00000000-0000-4000-8000-000000000001";
let browser: EventTarget;
type PopupFixture = {
  closed: boolean;
  close: () => void;
  location: { replace: (url: string) => void };
  postMessage: Mock<
    (message: BoundaryValue, origin: string, ports: MessagePort[]) => void
  >;
};
let popup: PopupFixture;
let target: string;
let session: Awaited<ReturnType<typeof signInLocalBrowser>> | null;
beforeEach(() => {
  target = "";
  session = null;
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
  browser = Object.assign(new EventTarget(), { open: () => popup });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("location", { origin: "https://rp.example.test" });
});
afterEach(() => {
  session?.close();
  browser.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
});

async function readyChannel(agent?: LocalBrowserProfile["agent"]) {
  const profile: LocalBrowserProfile = {
    authorizationEndpoint: `${origin}/identity/authorize`,
    clientId,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
  };
  if (agent) profile.agent = agent;
  const pending = signInLocalBrowser(profile);
  const result = pending.then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  await vi.waitFor(() => expect(target).not.toBe(""));
  const request = parseLocalAuthorizationRequest(new URL(target).search);
  function ready(source: PopupFixture, from = origin) {
    browser.dispatchEvent(
      Object.assign(new Event("message"), {
        source,
        origin: from,
        data: { type: "opensesame:local:ready", state: request.state },
      }),
    );
  }
  ready({ ...popup });
  ready(popup, "https://attacker.example.test");
  expect(popup.postMessage).not.toHaveBeenCalled();
  ready(popup);
  const port = popup.postMessage.mock.calls[0]?.[2][0];
  if (!port) throw new Error("Missing transferred port");
  return { result, port, request };
}

it("signs only the configured agent challenge before accepting an agent code", async () => {
  const key = await createLocalAgentKey();
  const principalId = "local_00000000-0000-4000-8000-000000000002";
  const sign = vi.fn((challenge) =>
    key.signChallenge(challenge, origin, principalId),
  );
  const { result, port, request } = await readyChannel({
    principalId,
    keyId: key.keyId,
    signChallenge: sign,
  });
  const challenge = {
    nonce: "n".repeat(43),
    principalId,
    keyId: key.keyId,
    origin,
    expiresAt: Date.now() + 60_000,
  };
  const proof = new Promise<MessageEvent>((resolve) => {
    port.onmessage = resolve;
  });
  port.postMessage({
    type: "agent_challenge",
    state: request.state,
    ...challenge,
    expiresAt: String(challenge.expiresAt),
  });
  const reply = (await proof).data;
  expect(reply.type).toBe("agent_proof");
  await verifyLocalAgentChallenge(reply.proof, challenge, key.publicKey);
  port.postMessage({
    type: "agent_verified",
    state: request.state,
    id: reply.id,
  });
  port.postMessage({ type: "closed", state: request.state });
  expect(await result).toHaveProperty("error");
  expect(sign).toHaveBeenCalledOnce();
  port.close();
});

it.each(["principalId", "keyId", "origin", "expiresAt"])(
  "never signs a mismatched agent challenge %s",
  async (field) => {
    const sign = vi.fn();
    const agent = {
      principalId: clientId,
      keyId: "k".repeat(43),
      signChallenge: sign,
    };
    const { result, port, request } = await readyChannel(agent);
    port.postMessage({
      type: "agent_challenge",
      state: request.state,
      nonce: "n".repeat(43),
      principalId: clientId,
      keyId: agent.keyId,
      origin,
      expiresAt: String(Date.now() + 60_000),
      [field]: "wrong",
    });
    expect(await result).toMatchObject({
      error: { message: "agent_authentication_failed" },
    });
    expect(sign).not.toHaveBeenCalled();
    port.close();
  },
);

async function connect() {
  const { result, port, request } = await readyChannel();
  const exchange = new Promise<MessageEvent>((resolve) => {
    port.onmessage = resolve;
  });
  port.postMessage({
    type: "code",
    state: request.state,
    code: "c".repeat(43),
  });
  const message = await exchange;
  const now = Date.now();
  const identity = {
    type: "identity",
    state: request.state,
    id: message.data.id,
    issuer: origin,
    audience: clientId,
    sub: "local_00000000-0000-4000-8000-000000000002",
    nonce: request.nonce,
    scope: "openid",
    authTime: String(now),
    expiresAt: String(now + 60_000),
  };
  return { result, port, identity };
}

it("accepts the exact popup/channel only and exposes no code or verifier", async () => {
  const { result, port, identity } = await connect();
  port.postMessage(identity);
  const outcome = await result;
  if (!("value" in outcome)) throw outcome.error;
  session = outcome.value;
  expect(session.identity.subject).toBe(identity.sub);
  expect(Object.keys(session).sort()).toEqual([
    "check",
    "close",
    "identity",
    "revoke",
  ]);
  expect(target).not.toContain("code_verifier");
  expect(target).not.toContain("access_token");
  port.close();
});

it("rejects an authorization code before proving the requested agent", async () => {
  const sign = vi.fn();
  const { result, port, request } = await readyChannel({
    principalId: clientId,
    keyId: "k".repeat(43),
    signChallenge: sign,
  });
  port.postMessage({
    type: "code",
    state: request.state,
    code: "c".repeat(43),
  });
  expect(await result).toHaveProperty("error");
  expect(sign).not.toHaveBeenCalled();
  expect(popup.closed).toBe(true);
  port.close();
});
it.each([
  { issuer: "https://attacker.example.test" },
  { audience: "other" },
  { nonce: "wrong" },
  { expiresAt: "0" },
  { authTime: "Infinity" },
  { type: "unverified" },
  { scope: "admin" },
])("refuses untrusted identity metadata %j", async (patch) => {
  const { result, port, identity } = await connect();
  port.postMessage({ ...identity, ...patch });
  const outcome = await result;
  expect(outcome).toHaveProperty("error");
  expect(outcome).toMatchObject({ error: { message: "invalid_identity" } });
  expect(popup.closed).toBe(true);
  port.close();
});

it("reports a stable refusal code without reflecting issuer error bodies", async () => {
  const { result, port, identity } = await connect();
  port.postMessage({
    type: "error",
    state: identity.state,
    id: identity.id,
    error: "private provider response sentinel",
  });
  expect(await result).toMatchObject({
    error: { message: "authorization_unavailable" },
  });
  expect(popup.closed).toBe(true);
  port.close();
});

it("refuses a scope outside consent before sending any request", async () => {
  const { result, port, identity } = await connect();
  port.postMessage(identity);
  const outcome = await result;
  if (!("value" in outcome)) throw outcome.error;
  session = outcome.value;
  const receive = vi.fn();
  port.onmessage = receive;
  await expect(session.check("records:write")).rejects.toThrow(
    "scope_not_granted",
  );
  expect(receive).not.toHaveBeenCalled();
  expect(popup.closed).toBe(false);
  port.close();
});

it.each(["popup_closed", "local_request_timeout"])(
  "fails closed with a stable %s reason",
  async (reason) => {
    vi.useFakeTimers();
    try {
      const { result, port } = await connect();
      if (reason === "popup_closed") popup.closed = true;
      await vi.advanceTimersByTimeAsync(
        reason === "local_request_timeout" ? 10_000 : 1000,
      );
      expect(await result).toMatchObject({ error: { message: reason } });
      expect(popup.closed).toBe(true);
      port.close();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("keeps consent usable after a wall-clock correction without extending its lifetime", async () => {
  vi.useFakeTimers();
  try {
    const { result, port } = await readyChannel();
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(popup.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toMatchObject({
      error: { message: "authorization_expired" },
    });
    expect(popup.closed).toBe(true);
    port.close();
  } finally {
    vi.useRealTimers();
  }
});

it.each([-3_600_000, 3_600_000])(
  "does not extend an active session when the wall clock changes by %i ms",
  async (correction) => {
    vi.useFakeTimers();
    try {
      const { result, port, identity } = await connect();
      port.postMessage(identity);
      const outcome = await result;
      if (!("value" in outcome)) throw outcome.error;
      session = outcome.value;
      vi.setSystemTime(Date.now() + correction);
      // The liveness timer observes expiry on its next one-second tick.
      await vi.advanceTimersByTimeAsync(correction < 0 ? 61_000 : 1000);
      expect(popup.closed).toBe(true);
      await expect(session.check()).rejects.toThrow(
        "local_session_unavailable",
      );
      port.close();
    } finally {
      vi.useRealTimers();
    }
  },
);
