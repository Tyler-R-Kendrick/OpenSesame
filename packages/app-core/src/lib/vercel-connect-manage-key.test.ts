/** @vitest-environment jsdom */
import type { JsonObject } from "@opensesame/os-domain";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyConnectCallbackBase } from "./connect-callback.js";
import { kvGet } from "./kv.js";
import {
  authorizeVercelConnection,
  createVercelConnection,
  listVercelConnections,
  revokeVercelConnection,
} from "./vercel-connect-ops.js";
import {
  CONNECT_AUTH_PATH,
  armVercelConnectAuth,
  clearPendingVercelConnectAuth,
  hydrateVercelConnectAuth,
  readVercelConnectAuth,
} from "./vercel-connect-session.js";
import {
  setVercelConnectAuth,
  vercelConnectAuth,
  vercelConnectConfigured,
} from "./vercel-connect.js";
import { lockAllTombs, tombFileKey, unlockTomb } from "./vfs.js";

const MANAGE_KEY = "operator-manage-key-0123456789abcdef";

function recordingStorage(writes: string[]): Storage {
  const rows = new Map<string, string>();
  return {
    get length() {
      return rows.size;
    },
    clear: () => rows.clear(),
    getItem: (key) => rows.get(key) ?? null,
    key: (index) => [...rows.keys()][index] ?? null,
    removeItem: (key) => {
      rows.delete(key);
    },
    setItem: (key, value) => {
      writes.push(`${key}=${value}`);
      rows.set(key, value);
    },
  };
}

function reply(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubRelay() {
  const spy = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/connect/authorize")) {
      return Promise.resolve(reply({ url: "https://vercel.com/authorize/x" }));
    }
    if (url.endsWith("/api/connect/revoke")) {
      return Promise.resolve(reply({ revoked: true }));
    }
    const connector = { id: "scl_slack", service: "slack", name: "acme" };
    return Promise.resolve(
      reply(
        url.endsWith("/connectors") && _init?.method === "POST"
          ? connector
          : { connectors: [connector] },
      ),
    );
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function authorizationOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

async function openTomb(): Promise<string> {
  const tomb = `connect-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  return tomb;
}

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});

afterEach(() => {
  clearPendingVercelConnectAuth();
  setVercelConnectAuth(null);
  applyConnectCallbackBase(undefined);
  lockAllTombs();
  vi.unstubAllGlobals();
});

describe("relay management key", () => {
  it("rides only on relay create, authorize and revoke", async () => {
    applyConnectCallbackBase("https://relay.example");
    setVercelConnectAuth({ token: "", manageKey: MANAGE_KEY });
    const spy = stubRelay();

    await listVercelConnections();
    await createVercelConnection({ providerId: "slack" });
    await authorizeVercelConnection("scl_slack");
    await revokeVercelConnection("scl_slack");

    const seen = spy.mock.calls.map(([url, init]) => [
      String(url).replace("https://relay.example", ""),
      authorizationOf(init),
    ]);
    expect(seen).toEqual([
      ["/api/connect/connectors", null],
      ["/api/connect/connectors", `Bearer ${MANAGE_KEY}`],
      ["/api/connect/authorize", `Bearer ${MANAGE_KEY}`],
      ["/api/connect/revoke", `Bearer ${MANAGE_KEY}`],
    ]);
    for (const [, init] of spy.mock.calls) {
      expect(String(init?.body ?? "")).not.toContain(MANAGE_KEY);
    }
  });

  it("sends no authorization when no key was provided", async () => {
    applyConnectCallbackBase("https://relay.example");
    const spy = stubRelay();
    await createVercelConnection({ providerId: "slack" });
    expect(authorizationOf(spy.mock.calls[0]?.[1])).toBeNull();
  });

  it("does not turn a key alone into a direct Connect transport", () => {
    setVercelConnectAuth({ token: "", manageKey: MANAGE_KEY });
    expect(vercelConnectConfigured()).toBe(false);
  });
});

describe("sealing the management key", () => {
  it("seals it in the tomb and never writes it in the clear", async () => {
    const writes: string[] = [];
    vi.stubGlobal("localStorage", recordingStorage(writes));
    vi.stubGlobal("sessionStorage", recordingStorage(writes));

    await armVercelConnectAuth(
      { token: "", manageKey: ` ${MANAGE_KEY} ` },
      null,
    );
    expect(vercelConnectAuth()?.manageKey).toBe(MANAGE_KEY);

    const tomb = await openTomb();
    await expect(hydrateVercelConnectAuth(tomb)).resolves.toBe(true);
    await expect(readVercelConnectAuth(tomb)).resolves.toEqual({
      token: "",
      manageKey: MANAGE_KEY,
    });

    const stored = kvGet(tombFileKey(tomb, CONNECT_AUTH_PATH)) ?? "";
    expect(stored).not.toBe("");
    expect(stored).not.toContain(MANAGE_KEY);
    expect(writes.join("\n")).not.toContain(MANAGE_KEY);
  });

  it("refuses a record with neither bearer", async () => {
    await expect(armVercelConnectAuth({ token: " " }, null)).rejects.toThrow();
  });
});
