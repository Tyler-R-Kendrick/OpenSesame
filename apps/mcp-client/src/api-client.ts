import { AgentClient, exactResource } from "@opensesame/agent-client";
import {
  createApiClient as createApiClientImpl,
  normalizeHttpBaseUrl,
} from "@opensesame/api-client";

const agent = new AgentClient("urn:opensesame:agent:mcp-client");

export { normalizeHttpBaseUrl };

export const apiClientSeams = {
  createApiClient: createApiClientImpl,
};

export function createApiClient(
  ...args: Parameters<typeof createApiClientImpl>
): ReturnType<typeof createApiClientImpl> {
  const options = args[0];
  const base = exactResource(options.baseUrl);
  const fetcher = options.fetchImpl ?? fetch;
  const scopedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("x-opensesame-operator");
    if (
      ![
        "/health",
        "/health/live",
        "/health/ready",
        "/.well-known/oauth-protected-resource",
      ].includes(url.pathname)
    ) {
      if (url.origin !== base) throw new Error("agent resource mismatch");
      for (const [key, value] of Object.entries(await agent.headers(base)))
        headers.set(key, value);
    }
    return fetcher(input, {
      ...init,
      headers,
      redirect: "error",
      credentials: "omit",
    });
  };
  return apiClientSeams.createApiClient({
    baseUrl: base,
    fetchImpl: scopedFetch,
  });
}

/** Validate launch authority before invoking an authenticated Host client operation. */
export async function createAuthenticatedApiClient(
  options: Parameters<typeof createApiClientImpl>[0],
): Promise<ReturnType<typeof createApiClientImpl>> {
  await agent.headers(exactResource(options.baseUrl));
  return createApiClient(options);
}
