import { vi } from "vitest";

export const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
export const CLIENT_SECRET = "universal-auth-secret-0123456789";
export const ACCESS = "eyJhbGciOiJIUzI1NiJ9.test-access-token-0123456789";
export const PROJECT = "9f4c2a10-1111-4222-8333-444455556666";

export const draft = (site = "us") => ({
  providerId: "infisical",
  displayName: "Infisical",
  parameters: { site },
  credentials: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
});

type Reply = { match: RegExp; body: unknown; status?: number };

/** Infisical in a function: whatever routes the test names, and nothing else. */
export function routes(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = replies.find((entry) => entry.match.test(url));
    if (!reply) throw new Error(`Unexpected request to ${url}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const assertCurrent = vi.fn();
  return { fetch, calls, transport: { fetch, assertCurrent } };
}

export const login = {
  match: /\/api\/v1\/auth\/universal-auth\/login$/,
  body: { accessToken: ACCESS, expiresIn: 7200, tokenType: "Bearer" },
};

export const names = {
  match: /\/api\/v3\/secrets\/raw\?/,
  body: {
    secrets: [
      { secretKey: "DATABASE_URL", secretValue: "postgres://hidden" },
      { secretKey: "API_TOKEN", secretValue: "hidden-too" },
    ],
    imports: [],
  },
};
