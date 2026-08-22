/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectivityBar } from "../../components/ConnectivityBar.js";
import {
  DEGRADED_MS,
  HEALTHY_MS,
  MAX_MS,
  resetConnectivityMonitorForTests,
} from "../connectivity-monitor.js";
import { clearHostSession, clearSession } from "../identity.js";
import { saveSettings } from "../settings.js";

/**
 * Chaos: break the network underneath a running bar and watch it converge.
 *
 * The unit tests drive the monitor through a mocked probe layer, which proves
 * the state machine but assumes the transport. This suite keeps the real
 * monitor, the real classifiers, the real component and the real
 * `localNetworkFetch`, and injects faults at `fetch` instead — planes that
 * die, come back, flap, time out, answer 500, or turn out to be a different
 * service on the same port.
 *
 * It exists because that is how the staleness bug was found: the bar was
 * green with every plane dead, and no unit test could see it, because every
 * unit test told the monitor what the answer was. The only thing that catches
 * "the bar is confidently wrong" is breaking something and looking.
 */
const HOST = "http://127.0.0.1:18787";
const IDENTITY = "http://127.0.0.1:18788";
const DAEMON = "http://127.0.0.1:18790";

type Mode = "up" | "down" | "timeout" | "error" | "impostor";

type ChaosEnvironment = {
  host: Mode;
  identity: Mode;
  daemon: Mode;
  flapEvery: number;
  calls: { host: number; identity: number; daemon: number };
};

const net: ChaosEnvironment = {
  host: "up",
  identity: "up",
  daemon: "up",
  /** Fail every Nth request, to simulate a flapping link. */
  flapEvery: 0,
  calls: { host: 0, identity: 0, daemon: 0 },
};

function which(url: string): "host" | "identity" | "daemon" | null {
  if (url.startsWith(HOST)) return "host";
  if (url.startsWith(IDENTITY)) return "identity";
  if (url.startsWith(DAEMON)) return "daemon";
  return null;
}

function bodyFor(target: "host" | "identity" | "daemon") {
  if (target === "daemon") {
    return {
      status: "ok",
      service: "opensesame-daemon",
      tailscale_url: null,
    };
  }
  return { status: "ok" };
}

/** A fetch that can be broken in each of the ways a real plane breaks. */
function chaosFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  const target = which(url);
  if (!target) return Promise.resolve(Response.json({}, { status: 404 }));
  net.calls[target] += 1;

  const flapping = net.flapEvery > 0 && net.calls[target] % net.flapEvery === 0;
  const mode: Mode = flapping ? "down" : net[target];

  switch (mode) {
    case "up":
      return Promise.resolve(Response.json(bodyFor(target)));
    case "down":
      return Promise.reject(new TypeError("Failed to fetch"));
    case "error":
      return Promise.resolve(Response.json({}, { status: 503 }));
    case "impostor":
      // Something is listening on the port; it is not us.
      return Promise.resolve(Response.json({ status: "ok", service: "nginx" }));
    case "timeout":
      // Never settles. `localNetworkFetch`'s abort timer is what ends it, so
      // advancing fake timers produces a real TimeoutError.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(
            // SAFETY: RequestInit.signal is the AbortSignal supplied by the test fetch seam.
            (init.signal as AbortSignal).reason ??
              new DOMException("aborted", "AbortError"),
          ),
        );
      });
  }
}

function glyph(name: string): HTMLElement {
  const found = screen
    .getAllByRole("button")
    .find((button) =>
      button.getAttribute("aria-label")?.startsWith(`${name} —`),
    );
  if (!found) throw new Error(`no glyph for ${name}`);
  return found;
}

function tone(name: string): string {
  const cls = glyph(name).className;
  if (cls.includes("cx__btn--live")) return "live";
  if (cls.includes("cx__btn--attn")) return "attn";
  if (cls.includes("cx__btn--offline")) return "offline";
  return "off";
}

function detail(name: string): string {
  return (glyph(name).getAttribute("aria-label") ?? "").split(" — ")[1] ?? "";
}

/** Let promise chains drain between timer advances. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

/** Advance far enough for one healthy sweep plus its confirming probe. */
async function waitOutHealthy(): Promise<void> {
  await vi.advanceTimersByTimeAsync(HEALTHY_MS * 1.3);
  await settle();
  await vi.advanceTimersByTimeAsync(DEGRADED_MS * 2);
  await settle();
}

/**
 * Advance far enough for a recovery to be noticed.
 *
 * Always keyed to MAX_MS, never to DEGRADED_MS: by the time a plane has been
 * down long enough to be worth restoring, the backoff ladder has usually
 * climbed to its ceiling. Tuning this to the tight cadence is how a chaos
 * test becomes a flake that passes on the jitter it happens to draw.
 */
async function waitOutRecovery(): Promise<void> {
  await vi.advanceTimersByTimeAsync(MAX_MS * 1.3);
  await settle();
}

function renderBar() {
  return render(
    <MemoryRouter>
      <ConnectivityBar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  net.host = "up";
  net.identity = "up";
  net.daemon = "up";
  net.flapEvery = 0;
  net.calls = { host: 0, identity: 0, daemon: 0 };
  clearSession();
  clearHostSession();
  resetConnectivityMonitorForTests();
  saveSettings({
    hostApi: HOST,
    identityApi: IDENTITY,
    daemonApi: DAEMON,
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
  vi.stubGlobal("fetch", vi.fn(chaosFetch));
});

afterEach(() => {
  cleanup();
  resetConnectivityMonitorForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearSession();
  clearHostSession();
});

describe("connectivity under chaos", () => {
  it("notices a plane dying with nobody touching the app", async () => {
    renderBar();
    await settle();
    expect(tone("Host")).toBe("live");

    // The regression this suite exists for: the bar used to stay green here
    // for the life of the tab, because nothing re-probed after first paint.
    net.host = "down";
    await waitOutHealthy();
    expect(tone("Host")).toBe("attn");
    expect(detail("Host")).toContain("127.0.0.1:18787");
  });

  it("notices it coming back, faster than it noticed it going", async () => {
    renderBar();
    await settle();
    net.host = "down";
    await waitOutHealthy();
    expect(tone("Host")).toBe("attn");

    net.host = "up";
    // However long it has been broken, the backoff ladder tops out at the
    // healthy interval — a plane someone is actively fixing must never be
    // checked less often than one that is fine.
    await waitOutRecovery();
    expect(tone("Host")).toBe("live");
  });

  it("holds steady through a flapping link instead of flickering", async () => {
    // Every third probe fails. Hysteresis needs two consecutive failures, so
    // a link this bad should never once turn the glyph amber — a bar that
    // flickers is a bar people learn to ignore.
    net.flapEvery = 3;
    renderBar();
    await settle();

    for (let round = 0; round < 8; round += 1) {
      await vi.advanceTimersByTimeAsync(HEALTHY_MS * 1.3);
      await settle();
      expect(tone("Host")).toBe("live");
    }
  });

  it("blames only the plane that is actually broken", async () => {
    renderBar();
    await settle();
    net.identity = "down";
    await waitOutHealthy();

    expect(tone("Identity")).toBe("attn");
    expect(tone("Host")).toBe("live");
    expect(tone("This machine")).toBe("live");
  });

  it("survives all three dying at once, and all three returning", async () => {
    renderBar();
    await settle();
    net.host = "down";
    net.identity = "down";
    net.daemon = "down";
    await waitOutHealthy();
    expect(tone("Host")).toBe("attn");
    expect(tone("This machine")).toBe("attn");

    net.host = "up";
    net.identity = "up";
    net.daemon = "up";
    await waitOutRecovery();
    expect(tone("Host")).toBe("live");
    expect(tone("This machine")).toBe("live");
  });

  it("calls a hung plane a timeout, not an unreachable one", async () => {
    // Different remedy: a timeout is usually something starting up or a slow
    // tailnet, where waiting is the right move.
    net.daemon = "timeout";
    renderBar();
    await settle();
    await waitOutHealthy();
    expect(tone("This machine")).toBe("attn");
    expect(detail("This machine")).toContain("No answer in time");
  });

  it("calls a foreign listener a foreign listener", async () => {
    net.daemon = "impostor";
    renderBar();
    await settle();
    await waitOutHealthy();
    expect(detail("This machine")).toContain("Not OpenSesame");
  });

  it("stops probing entirely while offline, and catches up when it returns", async () => {
    renderBar();
    await settle();

    window.dispatchEvent(new Event("offline"));
    await settle();
    expect(tone("Host")).toBe("offline");
    expect(detail("Host")).toBe("Offline");

    const before = { ...net.calls };
    await vi.advanceTimersByTimeAsync(HEALTHY_MS * 4);
    await settle();
    // A hidden or offline tab that keeps probing is just draining a battery
    // to learn nothing.
    expect(net.calls).toEqual(before);

    net.host = "down";
    window.dispatchEvent(new Event("online"));
    await settle();
    // Coming back is a person's whole reason to look at the bar, so it must
    // not wait for the next scheduled sweep.
    expect(net.calls.host).toBeGreaterThan(before.host);
  });

  it("does not let a slow answer pile up behind itself", async () => {
    net.host = "timeout";
    renderBar();
    await settle();
    const inFlight = net.calls.host;
    expect(inFlight).toBeGreaterThan(0);

    // Time passes while that first probe is still hanging — but less than the
    // abort timeout, so it has not finished. One in-flight request per target
    // means nothing new starts: otherwise a plane gets hammered hardest
    // exactly when it is already struggling to answer.
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(net.calls.host).toBe(inFlight);
  });
});
