import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectorStatus } from "../lib/connectors.js";

const env = vi.hoisted(() => ({
  connectors: [] as ConnectorStatus[],
}));

vi.mock("../lib/connectors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/connectors.js")>();
  return { ...actual, useConnectors: () => env.connectors };
});

const connectSpy = vi.hoisted(() => vi.fn());

vi.mock("../lib/identity.js", () => ({
  useConnect: () => ({ connect: connectSpy, connecting: false, error: null }),
}));

const checkNow = vi.hoisted(() => vi.fn());

vi.mock("../lib/connectivity-monitor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/connectivity-monitor.js")>();
  return {
    ...actual,
    checkNow,
    useConnectivityMonitor: () => ({
      offline: false,
      host: monitorTarget,
      identity: monitorTarget,
      machine: monitorTarget,
      nextCheckAt: Date.now() + 30_000,
    }),
  };
});

const monitorTarget = {
  health: "reachable" as const,
  failure: null,
  lastCheckedAt: Date.now() - 4_000,
  checking: false,
};

vi.mock("./PlaneNote.js", () => ({
  ConnectThisMachine: () => <div data-testid="pairing-ceremony" />,
}));

import { connectGitHistorySeams } from "./ConnectGitHistory.js";
Object.assign(connectGitHistorySeams, {
  ConnectGitHistory: () => <div data-testid="git-ceremony" />,
});

import { ConnectivityBar } from "./ConnectivityBar.js";

function status(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    id: "host",
    name: "Host",
    tone: "live",
    detail: "127.0.0.1:18787",
    required: true,
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
  status({ id: "identity", name: "Identity", detail: "127.0.0.1:18788" }),
  status({
    id: "machine",
    name: "This machine",
    tone: "attn",
    detail: "Not paired",
  }),
  status({
    id: "history",
    name: "Git history",
    detail: "GitHub · owner/store",
  }),
  status({
    id: "keys",
    name: "Key vault",
    detail: "WebCrypto (this device)",
    required: false,
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

describe("ConnectivityBar", () => {
  it("renders one glyph per connector, toned by state", () => {
    const { container } = renderBar();
    expect(container.querySelectorAll(".cx__btn").length).toBe(5);
    expect(container.querySelectorAll(".cx__btn--live").length).toBe(4);
    expect(container.querySelectorAll(".cx__btn--attn").length).toBe(1);
  });

  it("carries the whole status in the accessible name, since the glyph has none", () => {
    renderBar();
    expect(
      screen.getByRole("button", { name: "This machine — Not paired" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Host — 127.0.0.1:18787" }),
    ).toBeTruthy();
  });

  it("summarises how many required connectors are asking for something", () => {
    renderBar();
    expect(screen.getByRole("group", { name: /1 needs setup/ })).toBeTruthy();
  });

  it("does not count the optional key vault towards attention", () => {
    renderBar([
      status(),
      status({ id: "keys", name: "Key vault", tone: "attn", required: false }),
    ]);
    expect(screen.getByRole("group", { name: /all connected/i })).toBeTruthy();
  });

  it("opens the pairing ceremony from the machine glyph", () => {
    renderBar();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "This machine — Not paired" }),
    );
    const sheet = screen.getByRole("dialog", {
      name: "This machine connection",
    });
    expect(sheet).toBeTruthy();
    expect(sheet.tagName).toBe("DIV");
    expect(document.querySelector("dialog")).toBeNull();
    expect(screen.getByTestId("pairing-ceremony")).toBeTruthy();
  });

  it("keeps the rest of the app interactive while the machine sheet is open", () => {
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
      screen.getByRole("button", { name: "This machine — Not paired" }),
    );
    const vault = screen.getByRole("link", { name: "Vault" });
    expect(vault.closest("[inert]")).toBeNull();
    expect(vault.getAttribute("aria-hidden")).not.toBe("true");
    expect(
      screen.getByRole("dialog", { name: "This machine connection" }),
    ).toBeTruthy();
  });

  it("closes the ceremony on Escape and on the scrim", () => {
    renderBar();
    const open = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "This machine — Not paired" }),
      );

    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("re-checks through the monitor rather than probing on its own", () => {
    renderBar();
    checkNow.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Host — 127.0.0.1:18787" }),
    );
    // Opening a ceremony is a person asking, so it refreshes on the way in.
    expect(checkNow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(checkNow).toHaveBeenCalledTimes(2);

    // Endpoints are edited in one place, and it is not here.
    expect(
      screen
        .getByRole("link", { name: /Settings → Connectivity → Endpoints/ })
        .getAttribute("href"),
    ).toBe("/settings/connectivity");
  });

  it("says how old the verdict is and when the next one is due", () => {
    renderBar();
    fireEvent.click(
      screen.getByRole("button", { name: "Host — 127.0.0.1:18787" }),
    );
    const read = screen.getByRole("status");
    expect(read.textContent).toMatch(/Checked \d+s ago/);
    expect(read.textContent).toMatch(/next in \d+s/);
  });

  it("explains a classified failure in a sentence", () => {
    renderBar([
      status({
        tone: "attn",
        detail: "Not OpenSesame · 127.0.0.1:18787",
        failure: "not-opensesame",
        lastCheckedAt: Date.now(),
      }),
    ]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Host — Not OpenSesame · 127.0.0.1:18787",
      }),
    );
    expect(screen.getByText(/it is not the OpenSesame service/)).toBeTruthy();
  });

  it("settles once when a connector comes back, then stops", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = renderBar([
        status({ tone: "attn", detail: "Unreachable · 127.0.0.1:18787" }),
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

  it("offers Sign in from the Identity ceremony, and nowhere else", () => {
    renderBar();
    fireEvent.click(
      screen.getByRole("button", { name: "Host — 127.0.0.1:18787" }),
    );
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    fireEvent.click(
      screen.getByRole("button", { name: "Identity — 127.0.0.1:18788" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the freshness row off a connector nothing ever probes", () => {
    renderBar([
      status({
        id: "keys",
        name: "Key vault",
        detail: "WebCrypto (this device)",
        required: false,
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

  it("shows offline as its own thing, not as four broken endpoints", () => {
    renderBar([
      status({ tone: "offline", detail: "Offline" }),
      status({
        id: "identity",
        name: "Identity",
        tone: "offline",
        detail: "Offline",
      }),
    ]);
    expect(screen.getByRole("group", { name: /offline/i })).toBeTruthy();
  });

  it("opens the git ceremony from the history glyph", () => {
    renderBar();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Git history — GitHub · owner/store",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Git history connection" }),
    ).toBeTruthy();
    expect(screen.getByTestId("git-ceremony")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Change connector" })).toBeNull();
  });
});
