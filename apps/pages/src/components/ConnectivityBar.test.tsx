import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectorStatus } from "@opensesame/app-core/lib/connectors.js";

type ConnectivityBarTestEnvironment = { connectors: ConnectorStatus[] };
const env: ConnectivityBarTestEnvironment = { connectors: [] };
const connectSpy = vi.fn();
const beginSignIn = vi.fn();
const claimGuestAuth = vi.fn();
const checkNow = vi.fn();
const monitorTarget = {
  health: "reachable" as const,
  failure: null,
  lastCheckedAt: Date.now() - 4_000,
  checking: false,
  rttMs: 12,
};

import {
  ConnectivityBar,
  connectivityBarDependencies,
} from "./ConnectivityBar.js";
import { identityCeremonyDependencies } from "./IdentityCeremony.js";

Object.assign(identityCeremonyDependencies, {
  useConnect: () => ({ connect: connectSpy, connecting: false, error: null }),
  useIdentitySession: () => null,
  beginSignIn,
  defaultUpstream: () => ({
    id: "mock",
    displayName: "Local mock IdP",
    issuer: "http://127.0.0.1:9090",
    accountKind: "a seeded test account",
  }),
  claimGuestAuth,
  identityBase: () => "http://127.0.0.1:18788",
});

Object.assign(connectivityBarDependencies, {
  useConnectors: () => env.connectors,
  checkNow,
  useConnectivityMonitor: () => ({
    offline: false,
    identity: monitorTarget,
    nextCheckAt: Date.now() + 30_000,
  }),
  beginSignIn,
  defaultUpstream: () => ({
    id: "mock",
    displayName: "Local mock IdP",
    issuer: "http://127.0.0.1:9090",
    accountKind: "a seeded test account",
  }),
  claimGuestAuth,
  useConnect: () => ({ connect: connectSpy, connecting: false, error: null }),
});

function status(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    id: "identity",
    name: "Identity",
    tone: "live",
    detail: "127.0.0.1:18788",
    rttMs: 12,
    failure: null,
    // A probed connector has been checked; the freshness row only shows for
    // connectors that have a verdict to be stale.
    lastCheckedAt: Date.now() - 4_000,
    checking: false,
    ...over,
  };
}

const ALL: ConnectorStatus[] = [
  status(),
  status({
    id: "keys",
    name: "Key vault",
    detail: "WebCrypto (this device)",
  }),
];

function renderBar(connectors = ALL) {
  env.connectors = connectors;
  return render(
    <MemoryRouter>
      <ConnectivityBar />
    </MemoryRouter>,
  );
}

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

describe("ConnectivityBar", () => {
  it("renders one glyph per connector, toned by state", () => {
    const { container } = renderBar();
    expect(container.querySelectorAll(".cx__btn").length).toBe(2);
    expect(container.querySelectorAll(".cx__btn--live").length).toBe(2);
  });

  it("carries the whole status in the accessible name, since the glyph has none", () => {
    renderBar();
    expect(
      screen.getByRole("button", { name: "Identity — 127.0.0.1:18788" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Key vault — WebCrypto (this device)",
      }),
    ).toBeTruthy();
  });

  it("summarises how many connectors are asking for something", () => {
    renderBar([
      status({ tone: "attn", detail: "No identity session" }),
      status({
        id: "keys",
        name: "Key vault",
        detail: "WebCrypto (this device)",
      }),
    ]);
    expect(screen.getByRole("group", { name: /1 needs setup/ })).toBeTruthy();
  });

  it("does not count the key vault towards attention", () => {
    renderBar([
      status(),
      status({ id: "keys", name: "Key vault", tone: "attn" }),
    ]);
    expect(
      screen.getByRole("group", { name: /nothing needs setup/i }),
    ).toBeTruthy();
  });

  it("opens the identity ceremony from the identity glyph", () => {
    renderBar();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Identity — 127.0.0.1:18788" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Identity connection" }),
    ).toBeTruthy();
  });

  it("keeps the rest of the app interactive while the sheet is open", () => {
    env.connectors = ALL;
    render(
      <MemoryRouter>
        <nav>
          <a href="/vault">Vault</a>
        </nav>
        <ConnectivityBar />
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Identity — 127.0.0.1:18788" }),
    );
    const vault = screen.getByRole("link", { name: "Vault" });
    expect(vault.closest("[inert]")).toBeNull();
    expect(vault.getAttribute("aria-hidden")).not.toBe("true");
    expect(
      screen.getByRole("dialog", { name: "Identity connection" }),
    ).toBeTruthy();
  });

  it("closes the ceremony on Escape and on the scrim", () => {
    renderBar();
    const open = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Identity — 127.0.0.1:18788" }),
      );

    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus into the sheet on open and back to the glyph on close", () => {
    renderBar();
    const glyph = screen.getByRole("button", {
      name: "Identity — 127.0.0.1:18788",
    });
    glyph.focus();
    fireEvent.click(glyph);
    const sheet = screen.getByRole("dialog", {
      name: "Identity connection",
    });
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(glyph);
  });

  it("re-checks through the monitor rather than probing on its own", () => {
    renderBar();
    checkNow.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Identity — 127.0.0.1:18788" }),
    );
    // Opening a ceremony is a person asking, so it refreshes on the way in.
    expect(checkNow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(checkNow).toHaveBeenCalledTimes(2);
  });

  it("says how old the verdict is and when the next one is due", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    renderBar([status()]);
    fireEvent.click(
      screen.getByRole("button", { name: "Identity — 127.0.0.1:18788" }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Checked 4s ago · next in 30s",
    );
  });

  it("explains a classified failure in a sentence", () => {
    renderBar([
      status({
        tone: "attn",
        detail: "Not OpenSesame · 127.0.0.1:18788",
        failure: "not-opensesame",
        lastCheckedAt: Date.now(),
      }),
    ]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Identity — Not OpenSesame · 127.0.0.1:18788",
      }),
    );
    expect(screen.getByText(/it is not the OpenSesame service/)).toBeTruthy();
  });

  it("settles once when a connector comes back, then stops", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = renderBar([
        status({ tone: "attn", detail: "Unreachable · 127.0.0.1:18788" }),
      ]);
      expect(container.querySelector(".is-recovered")).toBeNull();

      // Amber to green is the one transition worth animating: the bar's whole
      // promise is that you do not have to keep watching it.
      env.connectors = [status({ tone: "live" })];
      rerender(
        <MemoryRouter>
          <ConnectivityBar />
        </MemoryRouter>,
      );
      expect(container.querySelector(".is-recovered")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(container.querySelector(".is-recovered")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not settle for a connector that was already green", () => {
    const { container, rerender } = renderBar([status({ tone: "live" })]);
    env.connectors = [status({ tone: "live", detail: "changed" })];
    rerender(
      <MemoryRouter>
        <ConnectivityBar />
      </MemoryRouter>,
    );
    expect(container.querySelector(".is-recovered")).toBeNull();
  });

  it("does not settle on the way *to* amber", () => {
    const { container, rerender } = renderBar([status({ tone: "live" })]);
    env.connectors = [status({ tone: "attn" })];
    rerender(
      <MemoryRouter>
        <ConnectivityBar />
      </MemoryRouter>,
    );
    expect(container.querySelector(".is-recovered")).toBeNull();
  });

  it("pulses while a probe is in flight without changing the tone", () => {
    const { container } = renderBar([status({ tone: "live", checking: true })]);
    const glyph = container.querySelector(".cx__btn");
    expect(glyph?.className).toContain("is-checking");
    // The tone is the last known truth; an in-flight check has not changed it.
    expect(glyph?.className).toContain("cx__btn--live");
  });

  it("offers registered sign-in and continue as guest from the Identity ceremony", async () => {
    connectSpy.mockResolvedValue(undefined);
    claimGuestAuth.mockResolvedValue(undefined);
    renderBar();
    fireEvent.click(
      screen.getByRole("button", { name: "Identity — 127.0.0.1:18788" }),
    );
    expect(
      screen.getByRole("button", {
        name: "Sign in with a seeded test account",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue as guest" }));
    await waitFor(() => expect(connectSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(claimGuestAuth).toHaveBeenCalledTimes(1));
  });

  it("keeps the freshness row off a connector nothing ever probes", () => {
    renderBar([
      status({
        id: "keys",
        name: "Key vault",
        detail: "WebCrypto (this device)",
        lastCheckedAt: null,
      }),
    ]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Key vault — WebCrypto (this device)",
      }),
    );
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });

  it("shows offline as its own thing, not as broken endpoints", () => {
    renderBar([
      status({ tone: "offline", detail: "Offline" }),
      status({
        id: "keys",
        name: "Key vault",
        tone: "offline",
        detail: "Offline",
      }),
    ]);
    expect(screen.getByRole("group", { name: /offline/i })).toBeTruthy();
  });
});
