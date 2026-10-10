import {
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

const connectSpy = vi.fn();
const beginSignIn = vi.fn();
const claimGuestAuth = vi.fn();
const checkNow = vi.fn();

import {
  ConnectionCeremony,
  connectionCeremonyDependencies,
} from "./ConnectionCeremony.js";
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

Object.assign(connectionCeremonyDependencies, {
  useConnectors: () => ALL,
  checkNow,
  useConnectivityMonitor: () => ({
    offline: false,
    identity: {
      health: "reachable" as const,
      failure: null,
      lastCheckedAt: Date.now() - 4_000,
      checking: false,
      rttMs: 12,
    },
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

function renderCeremony(
  id: ConnectorStatus["id"] = "identity",
  connectors = ALL,
) {
  return render(
    <MemoryRouter>
      <ConnectionCeremony
        id={id}
        connectors={connectors}
        onClose={() => {}}
        onSwitch={() => {}}
      />
    </MemoryRouter>,
  );
}

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

describe("ConnectionCeremony", () => {
  it("names the connection in the dialog, so a row of them is readable", () => {
    renderCeremony("keys");
    expect(
      screen.getByRole("dialog", { name: "Key vault connection" }),
    ).toBeTruthy();
  });

  it("keeps the rest of the app interactive while the sheet is open", () => {
    render(
      <MemoryRouter>
        <nav>
          <a href="/vault">Vault</a>
        </nav>
        <ConnectionCeremony
          id="identity"
          connectors={ALL}
          onClose={() => {}}
          onSwitch={() => {}}
        />
      </MemoryRouter>,
    );
    const vault = screen.getByRole("link", { name: "Vault" });
    expect(vault.closest("[inert]")).toBeNull();
    expect(vault.getAttribute("aria-hidden")).not.toBe("true");
    expect(
      screen.getByRole("dialog", { name: "Identity connection" }),
    ).toBeTruthy();
  });

  it("closes on Escape and on the scrim", () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ConnectionCeremony
          id="identity"
          connectors={ALL}
          onClose={onClose}
          onSwitch={() => {}}
        />
      </MemoryRouter>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves focus into the sheet on open and back to the opener on close", () => {
    const opener = document.createElement("button");
    opener.textContent = "Identity — 127.0.0.1:18788";
    document.body.append(opener);
    const onClose = vi.fn(() => opener.focus());
    opener.focus();
    render(
      <MemoryRouter>
        <ConnectionCeremony
          id="identity"
          connectors={ALL}
          onClose={onClose}
          onSwitch={() => {}}
        />
      </MemoryRouter>,
    );
    const sheet = screen.getByRole("dialog", {
      name: "Identity connection",
    });
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("re-checks through the monitor rather than probing on its own", () => {
    renderCeremony();
    checkNow.mockClear();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it("says how old the verdict is and when the next one is due", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    // The connector is stamped after the clock is mocked, so the age is real.
    renderCeremony("identity", [status()]);
    expect(screen.getByRole("status").textContent).toBe(
      "Checked 4s ago · next in 30s",
    );
  });

  it("explains a classified failure in a sentence", () => {
    renderCeremony("identity", [
      status({
        tone: "attn",
        detail: "Not OpenSesame · 127.0.0.1:18788",
        failure: "not-opensesame",
        lastCheckedAt: Date.now(),
      }),
    ]);
    expect(screen.getByText(/it is not the OpenSesame service/)).toBeTruthy();
  });

  it("offers registered sign-in and this device from the Identity ceremony", async () => {
    connectSpy.mockResolvedValue(undefined);
    claimGuestAuth.mockResolvedValue(undefined);
    renderCeremony();
    expect(
      screen.getByRole("button", {
        name: "Sign in with a seeded test account",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue as guest" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use this device" }));
    await waitFor(() => expect(connectSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(claimGuestAuth).toHaveBeenCalledTimes(1));
  });

  it("keeps the freshness row off a connector nothing ever probes", () => {
    renderCeremony("keys", [
      status({
        id: "keys",
        name: "Key vault",
        detail: "WebCrypto (this device)",
        lastCheckedAt: null,
      }),
    ]);
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });
});
