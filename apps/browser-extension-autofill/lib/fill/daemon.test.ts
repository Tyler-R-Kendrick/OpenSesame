import { describe, expect, it } from "vitest";
import {
  FillError,
  TOKEN_KEY,
  createDaemonClient,
  newToken,
  pairingToken,
} from "./daemon";

const TOKEN = "A".repeat(43);

function client(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const daemon = createDaemonClient({
    token: async () => TOKEN,
    base: "http://127.0.0.1:18790",
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    },
  });
  return { daemon, calls };
}

/** Any body a daemon fill route answers with, well-formed or not. */
interface DaemonBody {
  readonly error?: string;
  readonly field?: string;
  readonly value?: string;
  readonly state?: string;
  readonly code?: string;
  readonly references?: readonly (string | number | null)[];
  readonly truncated?: boolean;
}

const json = (body: DaemonBody, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("the daemon client", () => {
  it("sends the pairing token as a bearer, never credentials or cache", async () => {
    const { daemon, calls } = client(() =>
      json({ field: "password", value: "v" }),
    );
    await daemon.value("Web/example.com", "https://example.com", "password");
    const [call] = calls;
    expect(call?.url).toBe("http://127.0.0.1:18790/v1/fill");
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.cache).toBe("no-store");
    expect(call?.init.redirect).toBe("error");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(String(call?.init.body))).toEqual({
      reference: "Web/example.com",
      origin: "https://example.com",
      field: "password",
    });
  });

  it("names the daemon's refusal and nothing else", async () => {
    const { daemon } = client(() => json({ error: "no_match" }, 404));
    await expect(
      daemon.value("Web/x", "https://example.com", "password"),
    ).rejects.toEqual(new FillError("no_match"));
  });

  it("reads the daemon's bare 404 as the plugin switched off", async () => {
    // A daemon whose browser-autofill plugin is off answers exactly as for a
    // route it never served: 404, no body.
    const { daemon } = client(() => new Response(null, { status: 404 }));
    await expect(daemon.match("https://example.com")).rejects.toEqual(
      new FillError("plugin_off"),
    );
    await expect(daemon.pair()).rejects.toEqual(new FillError("plugin_off"));
  });

  it("refuses a value answered for another field", async () => {
    const { daemon } = client(() => json({ field: "username", value: "u" }));
    await expect(
      daemon.value("Web/x", "https://example.com", "password"),
    ).rejects.toThrow("unexpected_response");
  });

  it("reports an unreachable daemon", async () => {
    const daemon = createDaemonClient({
      token: async () => TOKEN,
      fetchImpl: async () => {
        throw new TypeError("connection refused");
      },
    });
    await expect(daemon.match("https://example.com")).rejects.toThrow(
      "daemon_unreachable",
    );
  });

  it("reads a pending pairing's code and a finished pairing", async () => {
    const pending = client(() =>
      json({ state: "pending", code: "ABCDEFGH" }, 202),
    );
    expect(await pending.daemon.pair()).toEqual({
      state: "pending",
      code: "ABCDEFGH",
    });
    const paired = client(() => json({ state: "paired" }));
    expect(await paired.daemon.pair()).toEqual({ state: "paired" });
  });

  it("keeps only string references from a match", async () => {
    const { daemon } = client(() =>
      json({ references: ["Web/a", 3, null, "Web/b"], truncated: false }),
    );
    expect(await daemon.match("https://example.com")).toEqual([
      "Web/a",
      "Web/b",
    ]);
  });
});

describe("the pairing token", () => {
  it("is 43 URL-safe characters from 32 random bytes", () => {
    const token = newToken((bytes) => bytes.fill(255));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is minted once and reused", async () => {
    const saved = new Map<string, string>();
    const store = {
      get: async (key: string) => saved.get(key),
      set: async (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    let draws = 0;
    const random = (bytes: Uint8Array) => {
      draws += 1;
      return bytes.fill(draws);
    };
    const first = await pairingToken(store, random);
    const second = await pairingToken(store, random);
    expect(first).toBe(second);
    expect(saved.get(TOKEN_KEY)).toBe(first);
    expect(draws).toBe(1);
  });
});
