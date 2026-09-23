import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalIssuerChannel } from "./local-issuer-channel.js";
import { vaultStore } from "./vault/store.js";

const request = {
  applicationId: "local_00000000-0000-4000-8000-000000000001",
  redirectUri: "https://rp.example.test/callback",
  scopes: ["openid"],
  state: "s".repeat(43),
  nonce: "n".repeat(43),
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256" as const,
};
const opener = { closed: false, postMessage: vi.fn() };
let browser: EventTarget;
let issuer: LocalIssuerChannel;
let pipes: MessageChannel[];
const status = vi.fn();
beforeEach(() => {
  browser = Object.assign(new EventTarget(), { opener });
  vi.stubGlobal("window", browser);
  pipes = [];
  issuer = new LocalIssuerChannel("test", request, status);
});
afterEach(() => {
  issuer.close();
  for (const pipe of pipes) {
    pipe.port1.close();
    pipe.port2.close();
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function connect(
  origin = "https://rp.example.test",
  source = opener,
  state = request.state,
) {
  const pipe = new MessageChannel();
  pipes.push(pipe);
  browser.dispatchEvent(
    Object.assign(new Event("message"), {
      origin,
      source,
      data: { type: "opensesame:local:connect", state },
      ports: [pipe.port2],
    }),
  );
  return pipe.port1;
}
it("addresses readiness only to the expected relying-party origin", () => {
  expect(opener.postMessage).toHaveBeenCalledWith(
    { type: "opensesame:local:ready", state: request.state },
    "https://rp.example.test",
  );
});
it("refuses wrong origin, source and state before accepting one channel", () => {
  connect("https://attacker.example.test");
  connect("null");
  connect("*");
  connect("https://rp.example.test", { closed: false, postMessage: vi.fn() });
  connect("https://rp.example.test", opener, "other");
  expect(status).not.toHaveBeenCalled();
  connect();
  connect();
  expect(status.mock.calls).toEqual([["connected"]]);
});
it("refuses RPC before human consent and closes the connected capability", async () => {
  const port = connect();
  const reply = new Promise<MessageEvent>((resolve) => {
    port.onmessage = resolve;
  });
  port.postMessage({ type: "userinfo", state: request.state, id: "1" });
  expect((await reply).data).toMatchObject({
    type: "error",
    error: "authorization_unavailable",
  });
  expect(status).toHaveBeenLastCalledWith("closed");
});
it("ends the channel on vault lock and cannot reconnect", () => {
  connect();
  vaultStore.lock();
  connect();
  expect(status.mock.calls).toEqual([["connected"], ["closed"]]);
});
it("does not admit expired pairing windows", () => {
  vi.useFakeTimers();
  issuer.close();
  status.mockClear();
  issuer = new LocalIssuerChannel("test", request, status);
  vi.advanceTimersByTime(300_000);
  connect();
  expect(status.mock.calls).toEqual([["closed"]]);
  vi.useRealTimers();
});
