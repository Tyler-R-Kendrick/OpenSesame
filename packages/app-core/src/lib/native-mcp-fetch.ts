/** MCP transport admission wraps an activated capability's egress, never global fetch. */
import {
  type NativeMcpBinding,
  NativeMcpError,
  admitNativeMcpRequest,
  nativeMcpUrl,
  validateNativeMcpBinding,
} from "./native-mcp-target.js";

export type NativeMcpAccessGrant = {
  token: string;
  providerId: string;
  fingerprint: string;
  issuer: string | null;
  resource: string;
};

export type NativeMcpTransportPorts = {
  fetch: typeof fetch;
  /** Reads one sealed grant, without exposing the device's other credentials. */
  accessGrant: () => Promise<NativeMcpAccessGrant | null>;
  /** Throws when vault, lease, configuration revision or actor is stale. */
  assertCurrent: () => void;
  authorizationRequired: () => Promise<void>;
};

const MAX_BYTES = 4 * 1024 * 1024;

function boundedBody(response: Response): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) throw new NativeMcpError("response");
        controller.enqueue(part.value);
      } catch {
        await reader.cancel().catch(() => undefined);
        controller.error(new NativeMcpError("response"));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function assertGrant(
  binding: NativeMcpBinding,
  grant: NativeMcpAccessGrant,
): void {
  if (
    !grant.token ||
    grant.providerId !== binding.providerId ||
    grant.fingerprint !== binding.fingerprint ||
    grant.issuer !== binding.issuer ||
    grant.resource !== binding.resource
  )
    throw new NativeMcpError("target");
}

async function assertReply(
  response: Response,
  ports: NativeMcpTransportPorts,
): Promise<void> {
  if (response.status === 401) {
    await response.body?.cancel();
    await ports.authorizationRequired();
    throw new NativeMcpError("authorization", 401);
  }
  if (response.status === 403) {
    await response.body?.cancel();
    throw new NativeMcpError("permission", 403);
  }
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    await response.body?.cancel();
    throw new NativeMcpError("target");
  }
}

export function nativeMcpFetch(
  binding: NativeMcpBinding,
  ports: NativeMcpTransportPorts,
  lifetime: AbortSignal,
): typeof fetch {
  validateNativeMcpBinding(binding);
  const target = Object.freeze({ ...binding });
  return async (input, init) => {
    ports.assertCurrent();
    if (lifetime.aborted) throw new NativeMcpError("disposed");
    const request = new Request(input, init);
    admitNativeMcpRequest(target, nativeMcpUrl(request.url), request.method);
    const grant = await ports.accessGrant();
    ports.assertCurrent();
    if (lifetime.aborted) throw new NativeMcpError("disposed");
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    if (grant) {
      assertGrant(target, grant);
      headers.set("authorization", `Bearer ${grant.token}`);
    }
    let response: Response;
    try {
      response = await ports.fetch(request, {
        headers,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([lifetime, request.signal]),
      });
    } catch (error) {
      if (error instanceof NativeMcpError) throw error;
      if (lifetime.aborted) throw new NativeMcpError("disposed");
      throw new NativeMcpError("browser-transport");
    }
    ports.assertCurrent();
    if (lifetime.aborted) {
      await response.body?.cancel();
      throw new NativeMcpError("disposed");
    }
    await assertReply(response, ports);
    return boundedBody(response);
  };
}
