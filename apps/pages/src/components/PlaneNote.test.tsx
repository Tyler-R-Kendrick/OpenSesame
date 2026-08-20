import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  plane: {
    host: "live" as string,
    hostBase: "https://host.example.com",
    identity: "connected" as string,
    identityBase: "https://id.example.com",
  },
  needsPairing: false,
  daemonApiSetting: "",
  loopbackPage: false,
  connect: vi.fn(),
  probeDaemon: vi.fn(),
  applyDaemonPairing: vi.fn(),
  assertReachable: vi.fn(),
  detectTailnet: vi.fn(),
  discoverTailscaleDaemon: vi.fn(),
  openTailscaleLogin: vi.fn(),
  waitForTailnet: vi.fn(),
}));

vi.mock("../lib/planes.js", () => ({
  PAGES_CANNOT_HOST: "Pages cannot host the Host API.",
  hostStatusLabel: (host: string) => `host:${host}`,
  identityStatusLabel: (identity: string) => `id:${identity}`,
  needsHostPairing: () => env.needsPairing,
  usePlaneStatus: () => env.plane,
}));

vi.mock("../lib/settings.js", () => ({
  loadSettings: () => ({
    daemonApi: env.daemonApiSetting,
    hostApi: "https://host.example.com",
    identityApi: "https://id.example.com",
  }),
  pageIsLoopback: () => env.loopbackPage,
  shippedDaemonApi: "http://127.0.0.1:18790",
}));

vi.mock("../lib/identity.js", () => ({
  useConnect: () => ({ connect: env.connect }),
}));

vi.mock("../lib/daemon.js", () => ({
  probeDaemon: env.probeDaemon,
  applyDaemonPairing: env.applyDaemonPairing,
}));

vi.mock("../lib/tailscale.js", () => ({
  assertDaemonReachableFromPage: env.assertReachable,
  detectTailnet: env.detectTailnet,
  discoverTailscaleDaemon: env.discoverTailscaleDaemon,
  openTailscaleLogin: env.openTailscaleLogin,
  waitForTailnet: env.waitForTailnet,
}));

vi.mock("../lib/urls.js", () => ({
  isLoopbackUrl: (url: string) =>
    url.includes("127.0.0.1") || url.includes("localhost"),
}));

import { ConnectThisMachine, PagesCannotHostNote } from "./PlaneNote.js";

function withRouter(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

const HEALTH = {
  status: "ok",
  service: "opensesame-daemon",
  hostApi: "https://host.example.com",
  identityApi: "https://id.example.com",
  tailscaleUrl: null as string | null,
};

function typeDaemonUrl(value: string) {
  fireEvent.change(screen.getByLabelText("Daemon (Tailscale Serve URL)"), {
    target: { value },
  });
}

/** Reach the manual field from the ceremony's opening step. */
function goManual() {
  fireEvent.click(screen.getByRole("button", { name: "Enter it myself" }));
}

describe("PagesCannotHostNote", () => {
  beforeEach(() => {
    env.needsPairing = false;
  });

  afterEach(cleanup);

  it("stays quiet while the Host plane is live or pending", () => {
    for (const host of ["live", "pending"]) {
      env.plane = { ...env.plane, host };
      const { container, unmount } = withRouter(
        <PagesCannotHostNote ceremony="Backup" />,
      );
      expect(container.firstChild).toBeNull();
      unmount();
    }
  });

  it("warns with the configured Host when it is simply down", () => {
    env.plane = { ...env.plane, host: "down", hostBase: "https://h.example" };
    withRouter(<PagesCannotHostNote ceremony="Backup" />);
    expect(screen.getByText(/Backup needs the Host API/)).toBeTruthy();
    expect(screen.getByText("https://h.example")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Change it in Settings" })
        .getAttribute("href"),
    ).toBe("/settings#connectivity");
  });

  it("shows 'none' when no Host is configured and it is down", () => {
    env.plane = { ...env.plane, host: "down", hostBase: "" };
    withRouter(<PagesCannotHostNote ceremony="Sync" />);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("renders nothing for non-down hosts that do not need pairing", () => {
    env.plane = { ...env.plane, host: "loopback" };
    const { container } = withRouter(<PagesCannotHostNote ceremony="Backup" />);
    expect(container.firstChild).toBeNull();
  });

  it("offers the pairing ceremony when pairing is needed", () => {
    env.needsPairing = true;
    env.plane = { ...env.plane, host: "unset", hostBase: "" };
    withRouter(<PagesCannotHostNote ceremony="Backup" />);
    expect(
      screen.getByRole("heading", { name: "Connect this machine" }),
    ).toBeTruthy();
    // Inline, the ceremony waits to be asked rather than sweeping the tailnet
    // on every section render.
    expect(env.discoverTailscaleDaemon).not.toHaveBeenCalled();
  });
});

describe("ConnectThisMachine", () => {
  beforeEach(() => {
    env.daemonApiSetting = "";
    env.loopbackPage = false;
    for (const fn of [
      env.connect,
      env.probeDaemon,
      env.applyDaemonPairing,
      env.assertReachable,
      env.detectTailnet,
      env.discoverTailscaleDaemon,
      env.openTailscaleLogin,
      env.waitForTailnet,
    ]) {
      fn.mockReset();
    }
    env.assertReachable.mockReturnValue(undefined);
    env.connect.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("opens on one primary action, with the field kept out of the way", () => {
    render(<ConnectThisMachine />);
    expect(screen.getByRole("button", { name: "Find my daemon" })).toBeTruthy();
    expect(screen.queryByLabelText("Daemon (Tailscale Serve URL)")).toBeNull();
  });

  it("discovers on mount when asked to, and offers what it found", async () => {
    env.discoverTailscaleDaemon.mockResolvedValue({
      ...HEALTH,
      tailscaleUrl: "https://found.tailnet.ts.net",
    });
    render(<ConnectThisMachine autoDiscover />);
    expect(
      await screen.findByText("https://found.tailnet.ts.net"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pair this daemon" }),
    ).toBeTruthy();
    // Nothing is paired until the operator says so.
    expect(env.applyDaemonPairing).not.toHaveBeenCalled();
  });

  it("tries the last pairing before sweeping the tailnet", async () => {
    env.daemonApiSetting = "https://box.tailnet.ts.net";
    env.probeDaemon.mockResolvedValue(HEALTH);
    render(<ConnectThisMachine autoDiscover />);
    expect(await screen.findByText("https://box.tailnet.ts.net")).toBeTruthy();
    expect(env.discoverTailscaleDaemon).not.toHaveBeenCalled();
  });

  it("pairs what it found and reports the endpoints it wrote", async () => {
    env.daemonApiSetting = "https://box.tailnet.ts.net";
    env.probeDaemon.mockResolvedValue(HEALTH);
    env.applyDaemonPairing.mockResolvedValue(undefined);
    const onPaired = vi.fn();
    render(<ConnectThisMachine autoDiscover onPaired={onPaired} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Pair this daemon" }),
    );

    await waitFor(() => {
      expect(env.applyDaemonPairing).toHaveBeenCalledWith(
        "https://box.tailnet.ts.net",
        HEALTH,
      );
    });
    // The three endpoints pairing writes are shown, which is what makes the
    // Endpoints panel safe to keep collapsed.
    expect(await screen.findByText("Daemon")).toBeTruthy();
    expect(screen.getByText("Host")).toBeTruthy();
    expect(screen.getByText("Identity")).toBeTruthy();
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(env.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps pairing even when the Identity connect fails afterwards", async () => {
    env.daemonApiSetting = "https://box.tailnet.ts.net";
    env.probeDaemon.mockResolvedValue(HEALTH);
    env.applyDaemonPairing.mockResolvedValue(undefined);
    env.connect.mockRejectedValue(new Error("identity down"));
    render(<ConnectThisMachine autoDiscover />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Pair this daemon" }),
    );
    expect(await screen.findByText("Daemon")).toBeTruthy();
  });

  it("prefers the daemon-reported tailscale URL when present", async () => {
    env.daemonApiSetting = "https://box.tailnet.ts.net";
    env.probeDaemon.mockResolvedValue({
      ...HEALTH,
      tailscaleUrl: "https://real.tailnet.ts.net",
    });
    env.applyDaemonPairing.mockResolvedValue(undefined);
    render(<ConnectThisMachine autoDiscover />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Pair this daemon" }),
    );
    await waitFor(() => {
      expect(env.applyDaemonPairing).toHaveBeenCalledWith(
        "https://real.tailnet.ts.net",
        expect.anything(),
      );
    });
  });

  it("falls back to the manual field when discovery finds nothing", async () => {
    env.discoverTailscaleDaemon.mockRejectedValue(
      new Error("no daemon on tailnet"),
    );
    env.detectTailnet.mockResolvedValue(true);
    render(<ConnectThisMachine autoDiscover />);
    expect(await screen.findByText("no daemon on tailnet")).toBeTruthy();
    expect(screen.getByLabelText("Daemon (Tailscale Serve URL)")).toBeTruthy();
    expect(env.openTailscaleLogin).not.toHaveBeenCalled();
  });

  it("asks for the Tailscale app when off the tailnet", async () => {
    env.discoverTailscaleDaemon.mockRejectedValue(new Error("nothing found"));
    env.detectTailnet.mockResolvedValue(false);
    env.waitForTailnet.mockResolvedValue(false);
    render(<ConnectThisMachine autoDiscover />);
    expect(await screen.findByText(/Still not on the tailnet/)).toBeTruthy();
    expect(env.openTailscaleLogin).toHaveBeenCalledTimes(1);
  });

  it("retries discovery once the machine joins the tailnet", async () => {
    env.discoverTailscaleDaemon
      .mockRejectedValueOnce(new Error("nothing found"))
      .mockResolvedValueOnce({
        ...HEALTH,
        tailscaleUrl: "https://joined.tailnet.ts.net",
      });
    env.detectTailnet.mockResolvedValue(false);
    env.waitForTailnet.mockResolvedValue(true);
    render(<ConnectThisMachine autoDiscover />);
    expect(
      await screen.findByText("https://joined.tailnet.ts.net"),
    ).toBeTruthy();
    expect(env.discoverTailscaleDaemon).toHaveBeenCalledTimes(2);
  });

  it("pairs a manually entered URL", async () => {
    env.probeDaemon.mockResolvedValue(HEALTH);
    env.applyDaemonPairing.mockResolvedValue(undefined);
    render(<ConnectThisMachine />);
    goManual();
    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Use this URL" }));
    await waitFor(() => {
      expect(env.applyDaemonPairing).toHaveBeenCalledWith(
        "https://box.tailnet.ts.net",
        HEALTH,
      );
    });
  });

  it("shows the probe failure when a typed daemon cannot be reached", async () => {
    env.probeDaemon.mockRejectedValue(new Error("connection refused"));
    render(<ConnectThisMachine />);
    goManual();
    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Use this URL" }));
    expect(await screen.findByText("connection refused")).toBeTruthy();
    expect(env.applyDaemonPairing).not.toHaveBeenCalled();
  });

  it("shows a generic failure for non-Error rejections", async () => {
    env.probeDaemon.mockRejectedValue("nope");
    render(<ConnectThisMachine />);
    goManual();
    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Use this URL" }));
    expect(
      await screen.findByText("Could not reach a daemon on this machine."),
    ).toBeTruthy();
  });

  it("rejects loopback daemons before probing", async () => {
    env.assertReachable.mockImplementation(() => {
      throw new Error("That daemon address is not one this page may call.");
    });
    render(<ConnectThisMachine />);
    goManual();
    typeDaemonUrl("http://127.0.0.1:18790");
    fireEvent.click(screen.getByRole("button", { name: "Use this URL" }));
    expect(
      await screen.findByText(
        "That daemon address is not one this page may call.",
      ),
    ).toBeTruthy();
    expect(env.probeDaemon).not.toHaveBeenCalled();
  });

  it("offers the shipped daemon as a fill on loopback pages", () => {
    env.loopbackPage = true;
    render(<ConnectThisMachine />);
    goManual();
    // Prefilled from the shipped default, so there is nothing left to offer.
    expect(
      (
        screen.getByLabelText(
          "Daemon (Tailscale Serve URL)",
        ) as HTMLInputElement
      ).value,
    ).toBe("http://127.0.0.1:18790");
  });

  it("offers the saved pairing as a fill once the box diverges from it", () => {
    env.daemonApiSetting = "https://box.tailnet.ts.net";
    render(<ConnectThisMachine />);
    goManual();
    typeDaemonUrl("https://other.tailnet.ts.net");
    const fill = screen.getByRole("button", {
      name: "https://box.tailnet.ts.net",
    });
    fireEvent.click(fill);
    expect(
      (
        screen.getByLabelText(
          "Daemon (Tailscale Serve URL)",
        ) as HTMLInputElement
      ).value,
    ).toBe("https://box.tailnet.ts.net");
  });

  it("offers the clipboard as a fill when it holds a URL", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "https://pasted.tailnet.ts.net/" },
    });
    render(<ConnectThisMachine />);
    goManual();
    expect(
      await screen.findByRole("button", {
        name: "https://pasted.tailnet.ts.net",
      }),
    ).toBeTruthy();
  });

  it("offers no clipboard chip for something that is not a URL", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "not a url at all" },
    });
    render(<ConnectThisMachine />);
    goManual();
    await waitFor(() => {
      expect(
        screen.getByLabelText("Daemon (Tailscale Serve URL)"),
      ).toBeTruthy();
    });
    // A chip that fills the field with junk is a dead end, not a shortcut.
    expect(screen.queryByRole("button", { name: /not a url/ })).toBeNull();
  });

  it("offers no clipboard chip for a non-http scheme", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "file:///etc/passwd" },
    });
    render(<ConnectThisMachine />);
    goManual();
    await waitFor(() => {
      expect(
        screen.getByLabelText("Daemon (Tailscale Serve URL)"),
      ).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /file:/ })).toBeNull();
  });

  it("survives the clipboard refusing permission", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => {
          throw new DOMException("denied", "NotAllowedError");
        },
      },
    });
    render(<ConnectThisMachine />);
    goManual();
    await waitFor(() => {
      expect(
        screen.getByLabelText("Daemon (Tailscale Serve URL)"),
      ).toBeTruthy();
    });
  });

  it("reports a failure to pair what discovery found", async () => {
    env.daemonApiSetting = "https://box.tailnet.ts.net";
    env.probeDaemon.mockResolvedValue(HEALTH);
    env.applyDaemonPairing.mockRejectedValue(new Error("could not write"));
    render(<ConnectThisMachine autoDiscover />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Pair this daemon" }),
    );
    expect(await screen.findByText("could not write")).toBeTruthy();
  });

  it("surfaces a second discovery failure after joining the tailnet", async () => {
    env.discoverTailscaleDaemon
      .mockRejectedValueOnce(new Error("nothing found"))
      .mockRejectedValueOnce(new Error("still nothing on the tailnet"));
    env.detectTailnet.mockResolvedValue(false);
    env.waitForTailnet.mockResolvedValue(true);
    render(<ConnectThisMachine autoDiscover />);
    expect(
      await screen.findByText("still nothing on the tailnet"),
    ).toBeTruthy();
    expect(env.discoverTailscaleDaemon).toHaveBeenCalledTimes(2);
  });

  it("does not touch state after being unmounted mid-discovery", async () => {
    const errors: unknown[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => errors.push(args));
    let release: (() => void) | undefined;
    env.discoverTailscaleDaemon.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ...HEALTH });
        }),
    );

    const { unmount } = render(<ConnectThisMachine autoDiscover />);
    unmount();
    release?.();
    await waitFor(() => {
      expect(env.discoverTailscaleDaemon).toHaveBeenCalled();
    });
    // A discovery that lands after the sheet closed must not drag the
    // ceremony back to a step the operator already left.
    expect(errors).toEqual([]);
    spy.mockRestore();
  });

  it("only offers the pairing QR for non-loopback URLs", () => {
    render(<ConnectThisMachine />);
    goManual();
    expect(screen.queryByRole("button", { name: "Show QR" })).toBeNull();

    typeDaemonUrl("http://127.0.0.1:18790");
    expect(screen.queryByRole("button", { name: "Show QR" })).toBeNull();

    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Show QR" }));
    expect(screen.getByRole("img", { name: /another device/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide QR" }));
    expect(screen.queryByRole("img", { name: /another device/ })).toBeNull();
  });
});
