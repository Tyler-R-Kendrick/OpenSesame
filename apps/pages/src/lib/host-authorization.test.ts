/** @vitest-environment jsdom */
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authorizeHost, hostAuthorizationSeams } from "./host-authorization.js";

const seam = { signal: new AbortController() };
const request = {
  operation: "agent.browser.control",
  target_id: "run-1",
  transition: "take",
} as const;
const popup = { postMessage: vi.fn(), close: vi.fn(), closed: false };
let popupWindow: Window;
let frame: HTMLIFrameElement;
const opened = vi.fn(() => popupWindow);
const fetched = vi.fn();
const original = { ...hostAuthorizationSeams };
let state = "";
const challenge = () => ({
  ...request,
  challenge_id: "challenge-1",
  challenge_digest: "a".repeat(64),
  origin: location.origin,
  host_audience: "https://host.example",
  organization_id: "org-1",
  dpop_jkt: "j".repeat(43),
  expires_at: Math.floor(Date.now() / 1000) + 290,
});
type PopupFixtureMessage = { type: string; state?: string; assertion?: string };
function message(
  data: PopupFixtureMessage,
  source: Window = popupWindow,
  origin = "https://identity.example",
) {
  window.dispatchEvent(
    new MessageEvent("message", { data: { state, ...data }, source, origin }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  frame = document.createElement("iframe");
  document.body.append(frame);
  if (!frame.contentWindow) throw new Error("Fixture window missing");
  popupWindow = frame.contentWindow;
  vi.spyOn(popupWindow, "postMessage").mockImplementation(popup.postMessage);
  vi.spyOn(popupWindow, "close").mockImplementation(popup.close);
  Object.defineProperty(popupWindow, "closed", {
    configurable: true,
    get: () => popup.closed,
  });
  seam.signal = new AbortController();
  hostAuthorizationSeams.identityBase = () => "https://identity.example";
  hostAuthorizationSeams.pairingSignal = () => seam.signal.signal;
  popup.closed = false;
  hostAuthorizationSeams.open = (url) => {
    state = new URL(url).searchParams.get("state") ?? "";
    return opened();
  };
  hostAuthorizationSeams.hostFetch = fetched;
  fetched
    .mockReset()
    .mockResolvedValueOnce(Response.json(challenge()))
    .mockResolvedValueOnce(
      Response.json({
        status: "authorized",
        elevation: "e".repeat(64),
        expires_at: Math.floor(Date.now() / 1000) + 290,
      }),
    );
});
afterEach(() => {
  seam.signal.abort();
  Object.assign(hostAuthorizationSeams, original);
  vi.restoreAllMocks();
  frame.remove();
});

it("binds popup source, exact origin, state, challenge and one-use redemption", async () => {
  const result = authorizeHost(request, new AbortController().signal);
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  message({ type: "opensesame:host-authorization-ready" }, window);
  message(
    { type: "opensesame:host-authorization-ready" },
    popupWindow,
    "https://attacker.example",
  );
  message({ type: "opensesame:host-authorization-ready", state: "wrong" });
  expect(fetched).not.toHaveBeenCalled();
  message({ type: "opensesame:host-authorization-ready" });
  await waitFor(() => expect(popup.postMessage).toHaveBeenCalledOnce());
  expect(popup.postMessage.mock.calls[0][1]).toBe("https://identity.example");
  message({
    type: "opensesame:host-authorization",
    assertion: "signed-fixture-for-wire-test",
  });
  message({ type: "opensesame:host-authorization", assertion: "duplicate" });
  await expect(result).resolves.toBe("e".repeat(64));
  expect(fetched).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetched.mock.calls[1][1].body)).toEqual({
    challenge_id: "challenge-1",
    assertion: "signed-fixture-for-wire-test",
  });
  expect(popup.close).toHaveBeenCalledOnce();
});

it("refuses a Host challenge whose displayed target differs from the clicked target", async () => {
  fetched
    .mockReset()
    .mockResolvedValue(
      Response.json({ ...challenge(), target_id: "other-run" }),
    );
  const result = authorizeHost(request, new AbortController().signal);
  message({ type: "opensesame:host-authorization-ready" });
  await expect(result).rejects.toThrow(/refused or expired/);
  expect(popup.postMessage).not.toHaveBeenCalled();
});

it("lock cancels the pending popup and cannot redeem a late assertion", async () => {
  const result = authorizeHost(request, new AbortController().signal);
  const rejected = expect(result).rejects.toThrow(/refused or expired/);
  message({ type: "opensesame:host-authorization-ready" });
  await waitFor(() => expect(popup.postMessage).toHaveBeenCalledOnce());
  seam.signal.abort();
  message({ type: "opensesame:host-authorization", assertion: "late" });
  await rejected;
  expect(fetched).toHaveBeenCalledOnce();
});

it("closing the popup refuses rather than silently applying a control action", async () => {
  const result = authorizeHost(request, new AbortController().signal);
  popup.closed = true;
  await expect(result).rejects.toThrow(/refused or expired/);
  expect(fetched).not.toHaveBeenCalled();
});
