import { vi } from "vitest";

export const TOKEN = "tskey-api-kABCDEF123456-secretsecretsecret";
export const CLIENT_ID = "k123CNTRL";
export const CLIENT_SECRET = "tskey-client-k123CNTRL-abcdefghijklmnop";
export const ACCESS = "tskey-api-kOAUTH0-minted-access-token-0123456789";

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
