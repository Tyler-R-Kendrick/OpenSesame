import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeFailureSeams } from "./probe-failure.js";
import { loadSettings, saveSettings } from "./settings.js";
import { transportCapabilities as browserCapabilities } from "./transport-capabilities.js";
import { transportStatusWire } from "./transport-status.fixture.js";
import {
  TRANSPORT_STATUS_PATH,
  TRANSPORT_VERIFY_PATH,
  lastTransportStatus,
  readTransportStatus,
  resetTransportStatusForTests,
  transportStatusSeams,
  transportVerifierOrigin,
} from "./transport-status.js";
import { runTransportVerify } from "./transport-verify.js";

const REMOTE = "https://authority.example.test";
const originalSeams = { ...transportStatusSeams };
const originalOnline = probeFailureSeams.isOnline;
const globalFetch = vi.fn<typeof fetch>();
const seamFetch =
  vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
  transportStatusSeams.fetch = seamFetch;
  transportStatusSeams.hostLocalSessionEligible = () => false;
  transportStatusSeams.now = () => Date.parse("2026-09-22T12:00:00Z");
  probeFailureSeams.isOnline = () => true;
  resetTransportStatusForTests();
  saveSettings({ ...loadSettings(), hostApi: "" });
});

afterEach(() => {
  Object.assign(transportStatusSeams, originalSeams);
  probeFailureSeams.isOnline = originalOnline;
  vi.unstubAllGlobals();
  globalFetch.mockReset();
  seamFetch.mockReset();
});

describe("nothing at boot", () => {
  it("importing the module and reading capabilities performs zero requests", () => {
    expect(browserCapabilities().browser_vault_key_injection.kind).toBe(
      "unsupported",
    );
    expect(browserCapabilities().browser_managed_external.kind).toBe(
      "external_provisioning_required",
    );
    expect(browserCapabilities().client_presents_certificate).toBe(false);
    expect(lastTransportStatus()).toBeNull();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(seamFetch).not.toHaveBeenCalled();
  });

  it("the boot path never imports the transport client", () => {
    const here = join(import.meta.dirname, "..");
    for (const file of [
      "main.tsx",
      "App.tsx",
      "webmcp/tools.ts",
      "webmcp/context.ts",
      "lib/vault/store.ts",
      "components/AppShell.tsx",
    ]) {
      expect(readFileSync(join(here, file), "utf8"), file).not.toMatch(
        /transport-(status|rows|agent-surface)/,
      );
    }
  });
});

describe("readTransportStatus", () => {
  it("is unconfigured, and asks nothing, without an endpoint", async () => {
    expect(transportVerifierOrigin()).toBeNull();
    expect(await readTransportStatus()).toEqual({ kind: "unconfigured" });
    expect(seamFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("reads a view from the configured endpoint anonymously, credentials omitted", async () => {
    saveSettings({ ...loadSettings(), hostApi: `${REMOTE}/` });
    seamFetch.mockResolvedValueOnce(json(transportStatusWire()));
    const result = await readTransportStatus();
    expect(result.kind).toBe("view");
    expect(seamFetch).toHaveBeenCalledWith(
      `${REMOTE}${TRANSPORT_STATUS_PATH}`,
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "error",
      }),
    );
    expect(lastTransportStatus()).toBe(result);
    if (result.kind === "view")
      expect(result.fetchedAt).toBe("2026-09-22T12:00:00.000Z");
  });

  it("uses the approved grant road when this browser holds one", async () => {
    saveSettings({ ...loadSettings(), hostApi: REMOTE });
    transportStatusSeams.hostLocalSessionEligible = () => true;
    const paired = vi.fn(async () => json(transportStatusWire()));
    transportStatusSeams.hostFetch = paired;
    expect((await readTransportStatus()).kind).toBe("view");
    expect(paired).toHaveBeenCalledWith(
      TRANSPORT_STATUS_PATH,
      expect.objectContaining({ method: "GET" }),
    );
    expect(seamFetch).not.toHaveBeenCalled();
  });

  it("is degraded when the endpoint does not answer, and names the failure", async () => {
    saveSettings({ ...loadSettings(), hostApi: REMOTE });
    seamFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await readTransportStatus()).toEqual({
      kind: "degraded",
      failure: "unreachable",
      status: null,
    });
    seamFetch.mockResolvedValueOnce(json({ error: "boom" }, 503));
    expect(await readTransportStatus()).toEqual({
      kind: "degraded",
      failure: "server-error",
      status: 503,
    });
  });

  it("is unauthorized on 401/403 — a fact about the target, never a retry with another credential", async () => {
    saveSettings({ ...loadSettings(), hostApi: REMOTE });
    seamFetch.mockResolvedValueOnce(json({ error: "unauthorized" }, 401));
    expect(await readTransportStatus()).toEqual({
      kind: "unauthorized",
      status: 401,
    });
    expect(seamFetch).toHaveBeenCalledTimes(1);
  });

  it("is malformed on a body that is not the whole view", async () => {
    saveSettings({ ...loadSettings(), hostApi: REMOTE });
    seamFetch.mockResolvedValueOnce(
      json(transportStatusWire({ desired: "auto" })),
    );
    expect(await readTransportStatus()).toEqual({ kind: "malformed" });
    seamFetch.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await readTransportStatus()).toEqual({ kind: "malformed" });
  });

  it("refuses a loopback endpoint on a non-loopback page as no endpoint at all", async () => {
    saveSettings({ ...loadSettings(), hostApi: "ftp://x" });
    expect(await readTransportStatus()).toEqual({ kind: "unconfigured" });
  });
});

describe("runTransportVerify", () => {
  it("POSTs the endpoint's own probe, then reads status back", async () => {
    saveSettings({ ...loadSettings(), hostApi: REMOTE });
    seamFetch
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json(transportStatusWire()));
    const result = await runTransportVerify();
    expect(result.kind).toBe("view");
    expect(
      seamFetch.mock.calls.map(([url, init]) => [url, init.method]),
    ).toEqual([
      [`${REMOTE}${TRANSPORT_VERIFY_PATH}`, "POST"],
      [`${REMOTE}${TRANSPORT_STATUS_PATH}`, "GET"],
    ]);
  });

  it("does not read back after a refused probe", async () => {
    saveSettings({ ...loadSettings(), hostApi: REMOTE });
    seamFetch.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    expect(await runTransportVerify()).toEqual({
      kind: "unauthorized",
      status: 403,
    });
    expect(seamFetch).toHaveBeenCalledTimes(1);
  });
});
