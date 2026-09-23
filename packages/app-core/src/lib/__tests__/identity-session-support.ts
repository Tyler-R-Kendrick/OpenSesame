import type { BoundaryValue } from "@opensesame/os-domain";
import { vi } from "vitest";

export const HOST = "http://127.0.0.1:18787";
export const IDENTITY = "http://127.0.0.1:18788";

export function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

export function provisionalBody(token = "identity_tok") {
  return {
    principalId: "principal_1",
    accessToken: token,
    expiresAt: "2099-01-01T00:00:00Z",
  };
}

/** The default plumbing: no cookie, provisional mint works, revoke works. */
export function stubBasic(
  handler?: (url: string, init?: RequestInit) => Response | undefined,
) {
  return stubFetch((url, init) => {
    const override = handler?.(url, init);
    if (override) return override;
    if (url === `${IDENTITY}/v1/principals/me`) return jsonResponse({}, 401);
    if (url === `${IDENTITY}/v1/principals/provisional`) {
      return jsonResponse(provisionalBody());
    }
    if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: "unexpected" }, 500);
  });
}
