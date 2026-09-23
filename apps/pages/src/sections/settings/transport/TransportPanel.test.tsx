import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { holdBrowserCertificate } from "@opensesame/app-core/lib/transport-browser.js";
import {
  loadTransportSettings,
  saveTransportSettings,
} from "@opensesame/app-core/lib/transport-settings.js";
import { transportStatusWire } from "@opensesame/app-core/lib/transport-status.fixture.js";
import {
  resetTransportStatusForTests,
  transportStatusSeams,
} from "@opensesame/app-core/lib/transport-status.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportPanel } from "./TransportPanel.js";

const REMOTE = "https://authority.example.test";
const originalSeams = { ...transportStatusSeams };
const globalFetch = vi.fn<typeof fetch>();
const seamFetch =
  vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const DIMENSIONS = [
  "desired",
  "credential",
  "runtime",
  "observed",
  "enforcement",
];

function row(dimension: string): HTMLElement {
  const node = document.querySelector(`[data-dimension="${dimension}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no ${dimension} row`);
  return node;
}

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
  transportStatusSeams.fetch = seamFetch;
  transportStatusSeams.hostLocalSessionEligible = () => false;
  transportStatusSeams.now = () => Date.parse("2026-09-22T12:00:00Z");
  resetTransportStatusForTests();
  saveSettings({ ...loadSettings(), hostApi: "" });
  saveTransportSettings({});
});

afterEach(() => {
  cleanup();
  holdBrowserCertificate(null);
  Object.assign(transportStatusSeams, originalSeams);
  vi.unstubAllGlobals();
  globalFetch.mockReset();
  seamFetch.mockReset();
});

describe("TransportPanel", () => {
  it("renders five idle rows, asks nothing, and offers no verification without an endpoint", async () => {
    render(<TransportPanel />);
    expect(screen.getByRole("heading", { name: "Transport" })).toBeTruthy();
    for (const dimension of DIMENSIONS)
      expect(row(dimension).dataset.tone).toBe(
        dimension === "desired" ? "idle" : "idle",
      );
    expect(
      screen.getByRole("button", { name: "Refresh transport status" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /verification/ })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seamFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    // No in-page error box, no text pill: status is a glyph with a sentence.
    expect(
      document.querySelector(".note, .conn-flash, [role=alert]"),
    ).toBeNull();
    expect(
      document.querySelectorAll(".status-mark").length,
    ).toBeGreaterThanOrEqual(5);
    expect(document.body.textContent).not.toMatch(
      /erased|TLS-gated|127\.0\.0\.1|localhost|unreachable|failed to/i,
    );
  });

  it("reads status on open when an endpoint is set; a bad remote degrades the observed row only", async () => {
    saveSettings({ ...loadSettings(), hostApi: REMOTE });
    seamFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<TransportPanel />);
    await waitFor(() => expect(row("observed").dataset.tone).toBe("err"));
    expect(seamFetch).toHaveBeenCalledTimes(1);
    for (const dimension of [
      "desired",
      "credential",
      "runtime",
      "enforcement",
    ]) {
      expect(row(dimension).dataset.tone).toBe("idle");
    }
    expect(
      screen.getByRole("button", { name: /Run enforcement verification/ }),
    ).toBeTruthy();
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /erased|TLS-gated|locked out|certificate to unlock/i,
    );
  });

  it("shows a verified answer as five rows and marks stale when the generation moves", async () => {
    saveSettings({ ...loadSettings(), hostApi: REMOTE });
    seamFetch.mockResolvedValueOnce(json(transportStatusWire()));
    render(<TransportPanel />);
    await waitFor(() => expect(row("enforcement").dataset.tone).toBe("ok"));
    expect(row("desired").dataset.tone).toBe("warn");
    expect(
      document.querySelector("#transport")?.getAttribute("data-stale"),
    ).toBe("false");

    seamFetch.mockResolvedValueOnce(
      json(
        transportStatusWire({
          runtime: {
            loaded: { generation: 4, loaded_at: "2026-09-22T11:30:00Z" },
          },
        }),
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh transport status" }),
    );
    await waitFor(() =>
      expect(
        document.querySelector("#transport")?.getAttribute("data-stale"),
      ).toBe("true"),
    );
    expect(row("enforcement").dataset.tone).toBe("warn");
    expect(
      screen.getByRole("img", {
        name: /Stale: verified against an earlier generation/,
      }),
    ).toBeTruthy();
  });

  it("runs verification as the endpoint's own probe, then re-reads", async () => {
    saveSettings({ ...loadSettings(), hostApi: REMOTE });
    seamFetch.mockResolvedValueOnce(
      json(transportStatusWire({ enforcement: "unverified" })),
    );
    render(<TransportPanel />);
    await waitFor(() => expect(row("credential").dataset.tone).toBe("ok"));
    seamFetch
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json(transportStatusWire()));
    await userEvent.click(
      screen.getByRole("button", { name: /Run enforcement verification/ }),
    );
    await waitFor(() => expect(row("enforcement").dataset.tone).toBe("ok"));
    expect(seamFetch.mock.calls.map(([, init]) => init.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("persists a reference and refuses a path without writing it", async () => {
    render(<TransportPanel />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Policy"), "mtls_required");
    expect(loadTransportSettings().remote?.desiredPolicy).toBe("mtls_required");
    expect(row("desired").textContent).toContain("mTLS required");

    const identity = screen.getByLabelText("Identity");
    await user.type(identity, "/etc/ssl/private/host.key");
    await user.tab();
    expect(
      screen.getByRole("img", { name: "A path is not a reference" }),
    ).toBeTruthy();
    expect(loadTransportSettings().remote?.identityRef).toBeUndefined();

    await user.clear(identity);
    await user.type(identity, "host-identity{Enter}");
    expect(loadTransportSettings().remote?.identityRef).toEqual({
      name: "host-identity",
    });
    expect(screen.queryByRole("img", { name: /not a reference/ })).toBeNull();
  });

  it("shows the browser-managed row only for that profile, with public-only keys", async () => {
    render(<TransportPanel />);
    expect(
      screen.queryByRole("button", { name: "Import public certificate" }),
    ).toBeNull();
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByLabelText("Remote profile"),
      "browser_managed",
    );
    expect(loadTransportSettings().remote?.browserProfile).toEqual({
      kind: "browser_managed",
      displayName: "Browser certificate",
    });
    expect(
      screen.getByRole("button", { name: "Import public certificate" }),
    ).toBeTruthy();
    const exportKey = screen.getByRole("button", {
      name: "Export public certificate",
    });
    expect(exportKey.hasAttribute("disabled")).toBe(true);
    expect(
      document.querySelector('[data-custody="browser_external"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/install|attach|fetch/i);
  });

  it("names a new target and keeps its settings apart", async () => {
    render(<TransportPanel />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Target"), "__new");
    await user.type(screen.getByLabelText("Target name"), "worker-tls{Enter}");
    await user.selectOptions(screen.getByLabelText("Runs in"), "worker");
    expect(loadTransportSettings()["worker-tls"]?.executionTarget).toBe(
      "worker",
    );
    expect(loadTransportSettings().remote).toBeUndefined();
  });
});
