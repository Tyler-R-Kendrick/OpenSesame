import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  plane: {
    host: "live",
    hostBase: "https://host.example.com",
    identity: "connected",
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

import { planeSeams } from "../lib/planes.js";
const originalPlaneSeams = { ...planeSeams };
Object.assign(planeSeams, {PAGES_CANNOT_HOST: "Pages cannot host the Host API.",
  hostStatusLabel: (host: string) => `host:${host}`,
  identityStatusLabel: (identity: string) => `id:${identity}`,
  needsHostPairing: () => env.needsPairing,
  usePlaneStatus: () => env.plane});
import { settingsSeams } from "../lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, {loadSettings: () => ({
    daemonApi: env.daemonApiSetting,
    hostApi: "https://host.example.com",
  }),
  pageIsLoopback: () => env.loopbackPage,
  shippedDaemonApi: "http://127.0.0.1:18790"});
import { identitySeams } from "../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {useConnect: () => ({ connect: env.connect })});
import { daemonSeams } from "../lib/daemon.js";
const originalDaemonSeams = { ...daemonSeams };
Object.assign(daemonSeams, {
  probeDaemon: env.probeDaemon,
  applyDaemonPairing: env.applyDaemonPairing,
});
import { tailscaleSeams } from "../lib/tailscale.js";
const originalTailscaleSeams = { ...tailscaleSeams };
Object.assign(tailscaleSeams, {
  assertDaemonReachableFromPage: env.assertReachable,
  detectTailnet: env.detectTailnet,
  discoverTailscaleDaemon: env.discoverTailscaleDaemon,
  openTailscaleLogin: env.openTailscaleLogin,
  waitForTailnet: env.waitForTailnet,
});
import { urlSeams } from "../lib/urls.js";
const originalUrlSeams = { ...urlSeams };
Object.assign(urlSeams, {
  isLoopbackUrl: (url: string) =>
    url.includes("127.0.0.1") || url.includes("localhost"),
});

import {
  ConnectThisMachine,
  PagesCannotHostNote,
  RailPlaneStatus,
} from "./PlaneNote.js";

function withRouter(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

const HEALTH = {
  status: "ok",
  service: "opensesame-daemon",
  hostApi: "https://host.example.com",
  identityApi: "https://id.example.com",
  tailscaleUrl: null,
};

function typeDaemonUrl(value: string) {
  fireEvent.change(screen.getByLabelText("Daemon (Tailscale Serve URL)"), {
    target: { value },
  });
}

describe("RailPlaneStatus", () => {
  afterEach(cleanup);

  it("shows a healthy dot when the Host is live", () => {
    env.plane = { ...env.plane, host: "live", identity: "connected" };
    const { container } = render(<RailPlaneStatus />);
    expect(container.querySelector(".dot--ok")).toBeTruthy();
    expect(screen.getByText("host:live")).toBeTruthy();
    expect(screen.getByText("id:connected")).toBeTruthy();
  });

  it("warns when the Host is neither live nor pending", () => {
    env.plane = { ...env.plane, host: "down", identity: "down" };
    const { container } = render(<RailPlaneStatus />);
    expect(container.querySelector(".dot--warn")).toBeTruthy();
    expect(screen.getByText("host:down")).toBeTruthy();
  });

  it("treats a pending probe as healthy-ish", () => {
    env.plane = { ...env.plane, host: "pending" };
    const { container } = render(<RailPlaneStatus />);
    expect(container.querySelector(".dot--ok")).toBeTruthy();
  });
});

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

  it("offers the pairing panel when pairing is needed", () => {
    env.needsPairing = true;
    env.plane = { ...env.plane, host: "unset", hostBase: "" };
    withRouter(<PagesCannotHostNote ceremony="Backup" />);
    expect(
      screen.getByRole("heading", { name: "Connect this machine" }),
    ).toBeTruthy();
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

  it("prefills from settings, or the shipped daemon on loopback pages", () => {
    env.daemonApiSetting = "https://box.tailnet.ts.net";
    const { unmount } = render(<ConnectThisMachine />);
    expect(
      (
        overlapCast(screen.getByLabelText(
          "Daemon (Tailscale Serve URL)",
        ))
      ).value,
    ).toBe("https://box.tailnet.ts.net");
    unmount();

    env.daemonApiSetting = "";
    env.loopbackPage = true;
    render(<ConnectThisMachine />);
    expect(
      (
        overlapCast(screen.getByLabelText(
          "Daemon (Tailscale Serve URL)",
        ))
      ).value,
    ).toBe("http://127.0.0.1:18790");
  });

  it("pairs directly with a reachable daemon and reports the pairing", async () => {
    env.probeDaemon.mockResolvedValue(HEALTH);
    env.applyDaemonPairing.mockResolvedValue(undefined);
    const onPaired = vi.fn();
    render(<ConnectThisMachine onPaired={onPaired} />);
    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Use this URL" }));

    expect(
      await screen.findByText(/Paired via https:\/\/box\.tailnet\.ts\.net/),
    ).toBeTruthy();
    expect(env.assertReachable).toHaveBeenCalledWith(
      "https://box.tailnet.ts.net",
    );
    expect(env.applyDaemonPairing).toHaveBeenCalledWith(
      "https://box.tailnet.ts.net",
      HEALTH,
    );
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(env.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps pairing even when the Identity connect fails afterwards", async () => {
    env.probeDaemon.mockResolvedValue(HEALTH);
    env.applyDaemonPairing.mockResolvedValue(undefined);
    env.connect.mockRejectedValue(new Error("identity down"));
    render(<ConnectThisMachine />);
    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Use this URL" }));
    expect(await screen.findByText(/Paired via/)).toBeTruthy();
  });

  it("prefers the daemon-reported tailscale URL when present", async () => {
    env.probeDaemon.mockResolvedValue({
      ...HEALTH,
      tailscaleUrl: "https://real.tailnet.ts.net",
    });
    env.applyDaemonPairing.mockResolvedValue(undefined);
    render(<ConnectThisMachine />);
    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Use this URL" }));
    expect(
      await screen.findByText(/Paired via https:\/\/real\.tailnet\.ts\.net/),
    ).toBeTruthy();
  });

  it("shows the probe failure when the daemon cannot be reached", async () => {
    env.probeDaemon.mockRejectedValue(new Error("connection refused"));
    render(<ConnectThisMachine />);
    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Use this URL" }));
    expect(await screen.findByText("connection refused")).toBeTruthy();
    expect(env.applyDaemonPairing).not.toHaveBeenCalled();
  });

  it("shows a generic failure for non-Error rejections", async () => {
    env.probeDaemon.mockRejectedValue("nope");
    render(<ConnectThisMachine />);
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
    typeDaemonUrl("http://127.0.0.1:18790");
    fireEvent.click(screen.getByRole("button", { name: "Use this URL" }));
    expect(
      await screen.findByText(
        "That daemon address is not one this page may call.",
      ),
    ).toBeTruthy();
    expect(env.probeDaemon).not.toHaveBeenCalled();
  });

  it("Tailscale connect: tries the typed URL first and stops on success", async () => {
    env.probeDaemon.mockResolvedValue(HEALTH);
    env.applyDaemonPairing.mockResolvedValue(undefined);
    render(<ConnectThisMachine />);
    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Connect Tailscale" }));
    expect(await screen.findByText(/Paired via/)).toBeTruthy();
    expect(env.discoverTailscaleDaemon).not.toHaveBeenCalled();
  });

  it("Tailscale connect: falls back to discovery when the typed URL fails", async () => {
    env.probeDaemon.mockRejectedValue(new Error("nope"));
    env.discoverTailscaleDaemon.mockResolvedValue({
      ...HEALTH,
      tailscaleUrl: "https://found.tailnet.ts.net",
    });
    env.applyDaemonPairing.mockResolvedValue(undefined);
    render(<ConnectThisMachine />);
    typeDaemonUrl("https://box.tailnet.ts.net");
    fireEvent.click(screen.getByRole("button", { name: "Connect Tailscale" }));
    expect(
      await screen.findByText(/Paired via https:\/\/found\.tailnet\.ts\.net/),
    ).toBeTruthy();
  });

  it("Tailscale connect: asks for the Tailscale app when off the tailnet", async () => {
    env.discoverTailscaleDaemon.mockRejectedValue(new Error("nothing found"));
    env.detectTailnet.mockResolvedValue(false);
    env.waitForTailnet.mockResolvedValue(false);
    render(<ConnectThisMachine />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Tailscale" }));

    // The install hint is immediately replaced by the outcome of the wait.
    expect(await screen.findByText(/Still not on the tailnet/)).toBeTruthy();
    expect(env.openTailscaleLogin).toHaveBeenCalledTimes(1);
  });

  it("Tailscale connect: retries discovery once the machine joins the tailnet", async () => {
    env.discoverTailscaleDaemon
      .mockRejectedValueOnce(new Error("nothing found"))
      .mockResolvedValueOnce({
        ...HEALTH,
        tailscaleUrl: "https://joined.tailnet.ts.net",
      });
    env.detectTailnet.mockResolvedValue(false);
    env.waitForTailnet.mockResolvedValue(true);
    env.applyDaemonPairing.mockResolvedValue(undefined);
    render(<ConnectThisMachine />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Tailscale" }));
    expect(
      await screen.findByText(/Paired via https:\/\/joined\.tailnet\.ts\.net/),
    ).toBeTruthy();
    expect(env.discoverTailscaleDaemon).toHaveBeenCalledTimes(2);
  });

  it("Tailscale connect: surfaces the discovery error when already on the tailnet", async () => {
    env.discoverTailscaleDaemon.mockRejectedValue(
      new Error("no daemon on tailnet"),
    );
    env.detectTailnet.mockResolvedValue(true);
    render(<ConnectThisMachine />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Tailscale" }));
    expect(await screen.findByText("no daemon on tailnet")).toBeTruthy();
    expect(env.openTailscaleLogin).not.toHaveBeenCalled();
  });

  it("only offers the pairing QR for non-loopback URLs", async () => {
    render(<ConnectThisMachine />);
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
