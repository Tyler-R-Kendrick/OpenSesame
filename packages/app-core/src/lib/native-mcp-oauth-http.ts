import {
  NativeMcpAuthError,
  type NativeMcpOAuthTarget,
} from "./native-mcp-oauth-target.js";
/** OAuth requests admit only the compiled discovery/registration/token tuple. */
import { NativeMcpError } from "./native-mcp-target.js";

const MAX_BYTES = 256 * 1024;

async function finiteResponse(response: Response): Promise<Response> {
  const reader = response.body?.getReader();
  if (!reader) return response;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new NativeMcpAuthError("metadata");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}

async function assertResponseDestination(response: Response): Promise<void> {
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    await response.body?.cancel();
    throw new NativeMcpAuthError("metadata");
  }
}

function assertRequestTarget(
  target: NativeMcpOAuthTarget,
  request: Request,
): void {
  const metadata = target.metadata;
  const allowed =
    request.method === "GET"
      ? [
          metadata.resourceMetadata,
          metadata.discoveryUrl,
          target.clientMetadataUrl,
        ]
      : request.method === "POST"
        ? [
            metadata.registrationEndpoint,
            metadata.tokenEndpoint,
            metadata.revocationEndpoint,
          ]
        : [];
  if (!allowed.includes(request.url)) throw new NativeMcpAuthError("metadata");
  if (request.headers.has("authorization"))
    throw new NativeMcpAuthError("public-client");
}

export function nativeMcpOAuthFetch(
  target: NativeMcpOAuthTarget,
  capabilityFetch: typeof fetch,
  signal: AbortSignal,
  assertCurrent: () => void,
  settleCredentialMutation?: typeof fetch,
): typeof fetch {
  const credentialEndpoints = [
    target.metadata.registrationEndpoint,
    target.metadata.tokenEndpoint,
  ];
  return async (input, init) => {
    assertCurrent();
    if (signal.aborted) throw new NativeMcpError("disposed");
    const request = new Request(input, init);
    assertRequestTarget(target, request);
    let response: Response;
    const issuedCredential =
      request.method === "POST" && credentialEndpoints.includes(request.url);
    const admittedFetch = issuedCredential
      ? (settleCredentialMutation ?? capabilityFetch)
      : capabilityFetch;
    const deadline = AbortSignal.timeout(15_000);
    try {
      response = await admittedFetch(request, {
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal:
          issuedCredential && settleCredentialMutation
            ? AbortSignal.any([request.signal, deadline])
            : AbortSignal.any([signal, request.signal, deadline]),
      });
    } catch {
      throw new NativeMcpError(
        signal.aborted ? "disposed" : "browser-transport",
      );
    }
    await assertResponseDestination(response);
    const finite = await finiteResponse(response);
    if (!issuedCredential || !settleCredentialMutation) {
      assertCurrent();
      if (signal.aborted) throw new NativeMcpError("disposed");
    }
    return finite;
  };
}
