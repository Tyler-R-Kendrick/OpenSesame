import { vi } from "vitest";

/** Synthetic fixture text. Pieces stay split so no source line is a full key. */
const fixtureKey = (parts: readonly string[]) => parts.join("");

export const TOKEN = fixtureKey([
  "ts",
  "key-",
  "api-",
  "kABCDEF",
  "123456-",
  "secret",
  "secret",
  "secret",
]);
export const CLIENT_ID = "k123CNTRL";
export const CLIENT_SECRET = fixtureKey([
  "ts",
  "key-",
  "client-",
  "k123",
  "CNTRL-",
  "abcdefgh",
  "ijklmnop",
]);
export const ACCESS = fixtureKey([
  "ts",
  "key-",
  "api-",
  "kOAUTH0-",
  "minted-",
  "access-",
  "token-",
  "01234567",
  "89",
]);
export const AUTH_KEY = fixtureKey([
  "ts",
  "key-",
  "auth-",
  "kAUTH1-",
  "01234567",
  "89abcdef",
]);
export const REPLACEMENT_SECRET = fixtureKey([
  "ts",
  "key-",
  "client-",
  "k123",
  "CNTRL-",
  "replacem",
  "entsecret",
]);
export const LEAK_MESSAGE = fixtureKey([
  "Key ",
  "ts",
  "key-",
  "api-",
  "kLEAK",
  " for user@private.example is invalid",
]);

export const token = (tailnet = "-") => ({
  providerId: "tailscale",
  displayName: "Tailscale",
  parameters: { tailnet },
  credentials: { api_token: TOKEN },
});
export const oauth = () => ({
  providerId: "tailscale",
  displayName: "Tailscale",
  parameters: {},
  credentials: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
});

type Reply = {
  match: RegExp;
  body?: unknown;
  status?: number;
  method?: string;
};

/** Tailscale's API in a function: whatever routes the test names, and nothing else. */
export function routes(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = replies.find(
      (entry) =>
        entry.match.test(url) &&
        (!entry.method || entry.method === (init?.method ?? "GET")),
    );
    if (!reply) throw new Error(`Unexpected request to ${url}`);
    return new Response(
      reply.body === undefined ? "" : JSON.stringify(reply.body),
      {
        status: reply.status ?? 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  return { fetch, calls, transport: { fetch, assertCurrent: vi.fn() } };
}

export const devices = {
  match: /\/tailnet\/[^/]+\/devices\?fields=default$/,
  body: {
    devices: [
      {
        id: "12345",
        hostname: "laptop",
        addresses: ["100.64.0.1", "fd7a::1"],
        authorized: true,
      },
      { id: "n6789", hostname: "phone", addresses: [], authorized: false },
    ],
  },
};

export const exchange = {
  match: /\/oauth\/token$/,
  method: "POST",
  body: { access_token: ACCESS, token_type: "Bearer", expires_in: 3600 },
};
