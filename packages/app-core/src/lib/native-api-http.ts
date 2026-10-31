/** Capability-fenced JSON transport; response errors never expose upstream material. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { EgressDenied } from "./capabilities/egress.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { nativeResponseJson } from "./native-response-json.js";

export class NativeApiError extends Error {
  constructor(
    readonly code:
      | "authorization"
      | "permission"
      | "rate-limit"
      | "response"
      | "deployment"
      | "bridge"
      | "network",
    readonly status = 0,
  ) {
    super(
      {
        authorization:
          "Provider authorization was refused; verify or replace the saved credential",
        permission: "Provider permissions do not allow this operation",
        "rate-limit": "Provider rate limit reached; try again later",
        response: "Provider did not return the expected response",
        deployment: "This deployment does not permit this provider endpoint",
        bridge:
          "The connector bridge could not make this request; open it, switch it on for this site and allow this provider's host",
        network:
          "Could not reach the provider from this browser; check its CORS policy and your connection",
      }[code],
    );
    this.name = "NativeApiError";
  }
}
export type NativeApiHttpRequest = {
  url: string | URL;
  method: "GET" | "POST";
  headers: Headers;
  body?: string;
  signal?: AbortSignal;
  /** Statuses the provider documents as proof; their body is never read. */
  validStatuses?: readonly number[];
};

async function reply(
  response: Response,
  signal: AbortSignal,
): Promise<BoundaryValue> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new NativeApiError("network");
  }
  try {
    return await nativeResponseJson(response, { maxBytes: 256 * 1024, signal });
  } catch {
    throw new NativeApiError("response", response.status);
  }
}
async function cancelUnreadResponse(
  response: Response | undefined,
): Promise<void> {
  if (response && !response.bodyUsed)
    await response.body?.cancel().catch(() => undefined);
}

/**
 * The statuses that refuse a credential, and how each is reported. The
 * contract schema refuses the same four as proofs
 * (`connect-provider-auth-schema.ts`).
 */
const REFUSALS: ReadonlyMap<number, NativeApiError["code"]> = new Map([
  [401, "authorization"],
  [403, "permission"],
  [407, "response"],
  [429, "rate-limit"],
]);

/**
 * True when the status alone is the answer: one the contract documents as
 * proof. A refusal, a redirected answer or any other non-2xx throws; a 2xx
 * answer is read.
 */
function answeredByStatus(
  request: NativeApiHttpRequest,
  response: Response,
): boolean {
  // Refusals come first, so no contract can turn one into a proof.
  const refused = REFUSALS.get(response.status);
  if (refused) throw new NativeApiError(refused, response.status);
  if (response.redirected)
    throw new NativeApiError("response", response.status);
  if (
    response.status >= 400 &&
    response.status <= 499 &&
    request.validStatuses?.includes(response.status)
  )
    return true;
  if (!response.ok) throw new NativeApiError("response", response.status);
  return false;
}

export async function nativeApiHttp(
  request: NativeApiHttpRequest,
  transport: NativeProviderTransport,
): Promise<BoundaryValue> {
  transport.assertCurrent();
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) controller.abort();
  const deadline = setTimeout(abort, 15_000);
  let response: Response | undefined;
  try {
    let body: BoundaryValue;
    try {
      if (controller.signal.aborted) throw new NativeApiError("network");
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        signal: controller.signal,
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      };
      if (request.body !== undefined) init.body = request.body;
      response = await transport.fetch(request.url, init);
      transport.assertCurrent();
      if (controller.signal.aborted) throw new NativeApiError("network");
      body = answeredByStatus(request, response)
        ? {}
        : await reply(response, controller.signal);
    } finally {
      try {
        // Keep the original request deadline and cancellation live through cleanup.
        await cancelUnreadResponse(response);
      } finally {
        clearTimeout(deadline);
        request.signal?.removeEventListener("abort", abort);
      }
    }
    transport.assertCurrent();
    if (controller.signal.aborted) throw new NativeApiError("network");
    return body;
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    if (error instanceof EgressDenied) throw new NativeApiError("deployment");
    throw new NativeApiError("network");
  }
}
