import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_KEY } from "./daemon";

const api = vi.hoisted(() => ({
  local: new Map<string, string>(),
  session: new Map<string, string>(),
  remove: vi.fn(),
  localSet: vi.fn(),
  sessionSet: vi.fn(),
  sessionAvailable: true,
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { id: "own", getURL: () => "chrome-extension://own/" },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: api.local.get(key) }),
        set: api.localSet,
        remove: api.remove,
      },
      get session() {
        return api.sessionAvailable
          ? {
              get: async (key: string) => ({ [key]: api.session.get(key) }),
              set: api.sessionSet,
            }
          : undefined;
      },
    },
  },
}));

import { browserFillPorts } from "./browser-ports";

const LEGACY = "A".repeat(43);

beforeEach(() => {
  vi.restoreAllMocks();
  api.local.clear();
  api.session.clear();
  api.sessionAvailable = true;
  api.local.set(TOKEN_KEY, LEGACY);
  api.remove.mockReset().mockImplementation(async (key: string) => {
    api.local.delete(key);
  });
  api.localSet.mockReset().mockImplementation(async (values) => {
    for (const [key, value] of Object.entries<string>(values)) {
      api.local.set(key, value);
    }
  });
  api.sessionSet.mockReset().mockImplementation(async (values) => {
    for (const [key, value] of Object.entries<string>(values)) {
      api.session.set(key, value);
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

function requests() {
  const tokens: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init: RequestInit) => {
      tokens.push(new Headers(init.headers).get("authorization") ?? "");
      return Response.json({ state: "paired" });
    }),
  );
  return tokens;
}

describe("the pairing bearer storage boundary", () => {
  it("deletes the legacy disk token at startup and never reuses it", async () => {
    const tokens = requests();
    const ports = browserFillPorts();
    await ports.daemon.pair();
    expect(api.local.has(TOKEN_KEY)).toBe(false);
    expect(api.localSet).not.toHaveBeenCalled();
    expect(tokens).toEqual([`Bearer ${api.session.get(TOKEN_KEY)}`]);
    expect(api.session.get(TOKEN_KEY)).not.toBe(LEGACY);
  });

  it("shares one token across concurrent requests and worker recreation", async () => {
    const tokens = requests();
    const ports = browserFillPorts();
    await Promise.all([ports.daemon.pair(), ports.daemon.pair()]);
    await browserFillPorts().daemon.pair();
    expect(new Set(tokens).size).toBe(1);
    expect(api.sessionSet).toHaveBeenCalledTimes(1);
  });

  it("mints a different token after the browser session ends", async () => {
    const tokens = requests();
    await browserFillPorts().daemon.pair();
    api.session.clear();
    await browserFillPorts().daemon.pair();
    expect(tokens[1]).not.toBe(tokens[0]);
    expect(api.local.size).toBe(0);
  });

  it("uses memory only when session storage is unavailable", async () => {
    api.sessionAvailable = false;
    const tokens = requests();
    const ports = browserFillPorts();
    await ports.daemon.pair();
    await ports.daemon.pair();
    expect(tokens[1]).toBe(tokens[0]);
    await browserFillPorts().daemon.pair();
    expect(tokens[2]).not.toBe(tokens[0]);
    expect(api.local.size).toBe(0);
    expect(api.sessionSet).not.toHaveBeenCalled();
  });

  it("never falls back to disk when session storage fails", async () => {
    const tokens = requests();
    api.sessionSet.mockRejectedValue(new Error("storage unavailable"));
    await expect(browserFillPorts().daemon.pair()).rejects.toThrow(
      "daemon_unreachable",
    );
    expect(tokens).toEqual([]);
    expect(api.local.size).toBe(0);
    expect(api.localSet).not.toHaveBeenCalled();
  });

  it("does not contact the daemon when legacy cleanup fails", async () => {
    const tokens = requests();
    api.remove.mockRejectedValue(new Error("storage unavailable"));
    await expect(browserFillPorts().daemon.pair()).rejects.toThrow(
      "daemon_unreachable",
    );
    expect(tokens).toEqual([]);
    expect(api.sessionSet).not.toHaveBeenCalled();
  });
});
