import { overlapCast, type BoundaryValue } from "@opensesame/os-domain";
// @vitest-environment jsdom
import type { Session } from "@opensesame/sdk-browser";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { apiClientSeams } from "./api-client";
import { clientCoreSeams } from "./client-core";
import { sdkBrowserSeams } from "./sdk-browser";

const mocks = {
  getSession: vi.fn(),
  continueAnonymously: vi.fn(),
  signOut: vi.fn(),
  createApiClient: vi.fn(),
  health: vi.fn(),
  probeDaemon: vi.fn(),
  loadSealedStore: vi.fn(),
  persistSealedStore: vi.fn(),
};

(
  overlapCast(globalThis)
).IS_REACT_ACT_ENVIRONMENT = true;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: "token",
    anonymous: true,
    sub: "sub_guest",
    raw: { access_token: "token", token_type: "Bearer" },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: BoundaryValue) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;

async function renderApp(): Promise<void> {
  await act(async () => {
    root.render(<App />);
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function statusItem(label: string): HTMLLIElement {
  const item = Array.from(
    container.querySelectorAll<HTMLLIElement>(".status li"),
  ).find((el) => el.querySelector(".label")?.textContent === label);
  if (!item) throw new Error(`status item not found: ${label}`);
  return item;
}

function alertText(): string | null {
  return container.querySelector("[role=alert]")?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  sdkBrowserSeams.createOpenSesame = () => ({
    getSession: mocks.getSession,
    continueAnonymously: mocks.continueAnonymously,
    signOut: mocks.signOut,
  });
  apiClientSeams.createApiClient = mocks.createApiClient;
  clientCoreSeams.loadSealedStore = mocks.loadSealedStore;
  clientCoreSeams.persistSealedStore = mocks.persistSealedStore;
  mocks.getSession.mockResolvedValue(null);
  mocks.continueAnonymously.mockResolvedValue(makeSession());
  mocks.signOut.mockResolvedValue(undefined);
  mocks.health.mockResolvedValue({ ok: true, body: "ok" });
  mocks.probeDaemon.mockResolvedValue({
    available: true,
    url: "http://127.0.0.1:18790",
    health: {},
  });
  mocks.createApiClient.mockReturnValue({
    health: mocks.health,
    probeDaemon: mocks.probeDaemon,
  });
  mocks.loadSealedStore.mockResolvedValue(null);
  mocks.persistSealedStore.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("App identity", () => {
  it("offers the guest on-ramp when there is no session", async () => {
    await renderApp();
    expect(container.textContent).toContain("No session.");
    expect(findButton("Continue as guest")).toBeDefined();
  });

  it("describes an anonymous session as provisional", async () => {
    mocks.getSession.mockResolvedValue(makeSession({ sub: "sub_guest" }));
    await renderApp();
    expect(container.textContent).toContain(
      "Guest session active (sub_guest).",
    );
    expect(container.textContent).toContain(
      "claim it later in the console to keep the same principal id",
    );
    expect(findButton("Sign out")).toBeDefined();
  });

  it("labels an anonymous session without a sub as a provisional principal", async () => {
    mocks.getSession.mockResolvedValue(makeSession({ sub: undefined }));
    await renderApp();
    expect(container.textContent).toContain(
      "Guest session active (provisional principal).",
    );
  });

  it("shows the signed-in subject for a claimed session", async () => {
    mocks.getSession.mockResolvedValue(
      makeSession({ anonymous: false, sub: "alice" }),
    );
    await renderApp();
    expect(container.textContent).toContain("Signed in as alice.");
    expect(container.textContent).not.toContain("provisional");
  });

  it("falls back to 'unknown' for a claimed session without a sub", async () => {
    mocks.getSession.mockResolvedValue(
      makeSession({ anonymous: false, sub: undefined }),
    );
    await renderApp();
    expect(container.textContent).toContain("Signed in as unknown.");
  });

  it("starts a guest session from the on-ramp button", async () => {
    mocks.continueAnonymously.mockResolvedValue(
      makeSession({ sub: "sub_new_guest" }),
    );
    await renderApp();
    await click(findButton("Continue as guest"));
    expect(mocks.continueAnonymously).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "Guest session active (sub_new_guest).",
    );
    expect(alertText()).toBeNull();
  });

  it("surfaces Identity API errors when starting a guest session", async () => {
    mocks.continueAnonymously.mockRejectedValue(new Error("identity is down"));
    await renderApp();
    await click(findButton("Continue as guest"));
    expect(alertText()).toBe("identity is down");
    expect(container.textContent).toContain("No session.");
  });

  it("uses a fallback message for non-Error guest failures", async () => {
    mocks.continueAnonymously.mockRejectedValue("socket reset");
    await renderApp();
    await click(findButton("Continue as guest"));
    expect(alertText()).toBe(
      "Could not start a guest session. Is the Identity API up?",
    );
  });

  it("disables the on-ramp while a guest session is starting", async () => {
    const pending = deferred<Session>();
    mocks.continueAnonymously.mockReturnValue(pending.promise);
    await renderApp();
    const button = findButton("Continue as guest");
    await click(button);
    const busy = container.querySelector("button.primary");
    expect(busy?.textContent).toBe("Starting…");
    expect(busy?.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      pending.resolve(makeSession());
      await pending.promise;
    });
    expect(container.textContent).toContain("Guest session active");
  });

  it("signs out and returns to the guest on-ramp", async () => {
    mocks.getSession.mockResolvedValue(makeSession());
    await renderApp();
    await click(findButton("Sign out"));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("No session.");
    expect(findButton("Continue as guest")).toBeDefined();
  });
});

describe("App health and sealed store", () => {
  it("reports host and daemon up and prepares a fresh sealed store", async () => {
    await renderApp();
    expect(statusItem("Host API").className).toBe("is-up");
    expect(statusItem("Host API").textContent).toContain("up");
    expect(statusItem("Daemon").className).toBe("is-up");
    expect(statusItem("Daemon").textContent).toContain("available");
    expect(statusItem("Sync cursor").textContent).toContain(
      "pwa-device @ epoch 0",
    );
    expect(statusItem("Local store").className).toBe("is-up");
    expect(statusItem("Local store").textContent).toContain(
      "Sealed local store ready",
    );
    expect(mocks.loadSealedStore).toHaveBeenCalledWith("pwa-device");
    expect(mocks.persistSealedStore).toHaveBeenCalledTimes(1);
    const [, sealed] = overlapCast(mocks.persistSealedStore.mock.calls[0]);
    expect(JSON.parse(sealed)).toEqual({
      cursor: { device_id: "pwa-device", epoch: 0 },
      blobs: [],
    });
  });

  it("adopts the cursor from an existing sealed store", async () => {
    mocks.loadSealedStore.mockResolvedValue(
      JSON.stringify({
        cursor: { device_id: "pwa-device", epoch: 7 },
        blobs: [],
      }),
    );
    await renderApp();
    expect(statusItem("Sync cursor").textContent).toContain(
      "pwa-device @ epoch 7",
    );
    expect(statusItem("Local store").textContent).toContain(
      "Sealed local store ready",
    );
  });

  it("reports host and daemon down with a recovery hint", async () => {
    mocks.health.mockResolvedValue({ ok: false, body: "nope" });
    mocks.probeDaemon.mockResolvedValue({ available: false });
    await renderApp();
    expect(statusItem("Host API").className).toBe("is-down");
    expect(statusItem("Host API").textContent).toContain("down");
    expect(statusItem("Daemon").className).toBe("");
    expect(statusItem("Daemon").textContent).toContain(
      "unavailable (optional)",
    );
    expect(container.querySelector("output.hint")?.textContent).toContain(
      "Host API is unreachable",
    );
  });

  it("treats a health-check network failure as down, not stuck on Checking", async () => {
    mocks.health.mockRejectedValue(new TypeError("Failed to fetch"));
    await renderApp();
    expect(statusItem("Host API").className).toBe("is-down");
    expect(statusItem("Host API").textContent).toContain("down");
    expect(statusItem("Daemon").textContent).toContain(
      "unavailable (optional)",
    );
    expect(container.querySelector("output.hint")?.textContent).toContain(
      "Host API is unreachable",
    );
  });

  it("surfaces host client misconfiguration errors", async () => {
    mocks.createApiClient.mockImplementation(() => {
      throw new Error("invalid baseUrl");
    });
    await renderApp();
    expect(statusItem("Host API").className).toBe("is-down");
    expect(statusItem("Local store").className).toBe("is-down");
    expect(statusItem("Local store").textContent).toContain("invalid baseUrl");
    expect(container.querySelector("output.hint")?.textContent).toContain(
      "Host API is unreachable",
    );
  });

  it("uses a fallback message for non-Error host misconfiguration", async () => {
    mocks.createApiClient.mockImplementation(() => {
      throw "not a url";
    });
    await renderApp();
    expect(statusItem("Local store").textContent).toContain(
      "Host API misconfigured",
    );
  });

  it("refuses to persist a store that fails sealed validation", async () => {
    mocks.loadSealedStore.mockResolvedValue('{"cursor":{"leak":"plaintext"}}');
    await renderApp();
    expect(statusItem("Local store").className).toBe("is-down");
    expect(statusItem("Local store").textContent).toContain(
      "sealed_json_contains_plaintext",
    );
    expect(mocks.persistSealedStore).not.toHaveBeenCalled();
  });

  it("uses a fallback message for non-Error store failures", async () => {
    mocks.persistSealedStore.mockRejectedValue("disk full");
    await renderApp();
    expect(statusItem("Local store").className).toBe("is-down");
    expect(statusItem("Local store").textContent).toContain(
      "Could not prepare local store",
    );
  });

  it("re-runs the health check from the retry button", async () => {
    await renderApp();
    expect(mocks.health).toHaveBeenCalledTimes(1);
    await click(findButton("Retry health check"));
    expect(mocks.health).toHaveBeenCalledTimes(2);
    expect(mocks.probeDaemon).toHaveBeenCalledTimes(2);
  });

  it("disables the retry button while a check is running", async () => {
    const pending = deferred<{ ok: boolean; body: string }>();
    mocks.health.mockReturnValue(pending.promise);
    await renderApp();
    const busy = findButton("Checking…");
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(statusItem("Host API").textContent).toContain("Checking…");
    await act(async () => {
      pending.resolve({ ok: true, body: "ok" });
      await pending.promise;
    });
    expect(findButton("Retry health check")).toBeDefined();
  });
});
