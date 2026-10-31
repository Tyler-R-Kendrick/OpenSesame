import { vi } from "vitest";
import {
  fakeTailscaleApiKey,
  fakeTailscaleAuthKey,
  fakeTailscaleClientId,
  fakeTailscaleClientKey,
  fakeTailscaleLeakMessage,
} from "./fake-tailscale-key.js";

export type NativeTailscaleFixtures = {
  apiToken: string;
  accessToken: string;
  clientId: string;
  clientSecret: string;
  authKey: string;
  replacementClientSecret: string;
  leakMessage: string;
  token: (tailnet?: string) => {
    providerId: string;
    displayName: string;
    parameters: { tailnet: string };
    credentials: { api_token: string };
  };
  oauth: () => {
    providerId: string;
    displayName: string;
    parameters: Record<string, never>;
    credentials: { client_id: string; client_secret: string };
  };
  exchange: {
    match: RegExp;
    method: string;
    body: {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
  };
};

/** Fresh fake Tailscale credentials and route stubs for one test. */
export function createNativeTailscaleFixtures(): NativeTailscaleFixtures {
  const apiToken = fakeTailscaleApiKey();
  const accessToken = fakeTailscaleApiKey();
  const clientId = fakeTailscaleClientId();
  const clientSecret = fakeTailscaleClientKey();
  const authKey = fakeTailscaleAuthKey();
  const replacementClientSecret = fakeTailscaleClientKey();
  const leakMessage = fakeTailscaleLeakMessage(apiToken);
  return {
    apiToken,
    accessToken,
    clientId,
    clientSecret,
    authKey,
    replacementClientSecret,
    leakMessage,
    token: (tailnet = "-") => ({
      providerId: "tailscale",
      displayName: "Tailscale",
      parameters: { tailnet },
      credentials: { api_token: apiToken },
    }),
    oauth: () => ({
      providerId: "tailscale",
      displayName: "Tailscale",
      parameters: {},
      credentials: { client_id: clientId, client_secret: clientSecret },
    }),
    exchange: {
      match: /\/oauth\/token$/,
      method: "POST",
      body: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
      },
    },
  };
}

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
