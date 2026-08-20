import { type BoundaryValue } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConnectivityMonitorForTests } from "./connectivity-monitor.js";
import {
  clearHostSession,
  clearSession,
  resetHostHealthPathForTests,
} from "./identity.js";
import { usePlaneStatus } from "./planes.js";
import { saveSettings } from "./settings.js";

const HOST = "http://127.0.0.1:18787";
const IDENTITY = "http://127.0.0.1:18788";

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function Probe() {
  const status = usePlaneStatus();
  return (
    <output>
      {status.host}|{status.identity}|{status.hostBase}|{status.identityBase}
    </output>
  );
}

beforeEach(() => {
  clearSession();
  clearHostSession();
  // The monitor is a module singleton by design — one schedule per tab — so a
  // test that does not reset it inherits the previous test's verdicts.
  resetConnectivityMonitorForTests();
  resetHostHealthPathForTests();
  saveSettings({
    hostApi: HOST,
    identityApi: IDENTITY,
    daemonApi: "http://127.0.0.1:18790",
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
});

afterEach(() => {
  resetConnectivityMonitorForTests();
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usePlaneStatus", () => {
  it("probes both planes and reports them live", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${HOST}/api/v1/health`) {
          return Promise.resolve(jsonResponse({ status: "ok" }));
        }
        if (url === `${IDENTITY}/v1/health/live`) {
          return Promise.resolve(jsonResponse({ status: "ok" }));
        }
        return Promise.resolve(jsonResponse({}, 404));
      }),
    );

    render(<Probe />);

    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`^live\\|none\\|${HOST}`)),
      ).toBeTruthy();
    });
  });

  it("re-probes when settings change", async () => {
    let hostUp = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${HOST}/api/v1/health` || url === `${HOST}/health/live`) {
          return hostUp
            ? Promise.resolve(jsonResponse({ status: "ok" }))
            : Promise.reject(new TypeError("Failed to fetch"));
        }
        if (url === `${IDENTITY}/v1/health/live`) {
          return Promise.resolve(jsonResponse({ status: "ok" }));
        }
        return Promise.resolve(jsonResponse({}, 404));
      }),
    );

    render(<Probe />);
    // A loopback Host that does not answer is "not on this page", not down.
    await waitFor(() => {
      expect(screen.getByText(/^loopback\|/)).toBeTruthy();
    });

    hostUp = true;
    act(() => {
      saveSettings({
        hostApi: HOST,
        identityApi: IDENTITY,
        daemonApi: "http://127.0.0.1:18790",
        tursoUrl: "",
        mfaAppUrl: "",
        capabilityConnectors: {
          encryption: { providerId: "webcrypto" },
          history: { providerId: "github" },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/^live\|/)).toBeTruthy();
    });
  });
});
