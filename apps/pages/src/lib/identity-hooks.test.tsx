/** @vitest-environment jsdom */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHostSession,
  clearSession,
  connectProvisional,
  probeOrphanSession,
  useConnect,
  useIdentitySession,
  useOrphanSession,
} from "./identity.js";
import { saveSettings } from "./settings.js";

const IDENTITY = "http://127.0.0.1:18788";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function SessionProbe() {
  const session = useIdentitySession();
  return <output>{session ? session.principalId : "none"}</output>;
}

function OrphanProbe() {
  const orphan = useOrphanSession();
  return <output>{orphan ? "orphan" : "clean"}</output>;
}

let connectApi: ReturnType<typeof useConnect>;
function ConnectProbe() {
  connectApi = useConnect();
  return (
    <output>
      {connectApi.connecting ? "connecting" : "idle"}|
      {connectApi.error ?? "no-error"}
    </output>
  );
}

beforeEach(() => {
  clearSession();
  clearHostSession();
  saveSettings({
    hostApi: "http://127.0.0.1:18787",
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
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useIdentitySession", () => {
  it("follows connect and lock", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse({
          principalId: "principal_hook",
          accessToken: "identity_hook",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }
      return jsonResponse({}, 500);
    });
    render(<SessionProbe />);
    expect(screen.getByText("none")).toBeTruthy();

    await act(async () => {
      await connectProvisional();
    });
    expect(screen.getByText("principal_hook")).toBeTruthy();

    act(() => {
      clearSession();
    });
    expect(screen.getByText("none")).toBeTruthy();
  });
});

describe("useOrphanSession", () => {
  it("flips on when a leftover cookie authenticates", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({ id: "principal_leftover" });
      }
      return jsonResponse({}, 500);
    });
    render(<OrphanProbe />);
    expect(screen.getByText("clean")).toBeTruthy();

    await act(async () => {
      await probeOrphanSession();
    });
    expect(screen.getByText("orphan")).toBeTruthy();
  });
});

describe("useConnect", () => {
  it("connects and reports failures without throwing", async () => {
    let refuse = true;
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({}, 401);
      }
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return refuse
          ? jsonResponse({ message: "provisioning disabled" }, 403)
          : jsonResponse({
              principalId: "principal_hook",
              accessToken: "identity_hook",
              expiresAt: "2099-01-01T00:00:00Z",
            });
      }
      return jsonResponse({}, 500);
    });
    render(<ConnectProbe />);
    expect(screen.getByText(/idle/)).toBeTruthy();

    await act(async () => {
      await connectApi.connect();
    });
    expect(screen.getByText(/provisioning disabled/)).toBeTruthy();

    refuse = false;
    await act(async () => {
      await connectApi.connect();
    });
    expect(screen.getByText(/no-error/)).toBeTruthy();
  });
});
