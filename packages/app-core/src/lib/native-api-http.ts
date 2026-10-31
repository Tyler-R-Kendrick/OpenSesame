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
 * True when the status alone is the answer: one the contract documents as
 * proof. A refusal or any other non-2xx throws; a 2xx answer is read.
 */
function answeredByStatus(
  request: NativeApiHttpRequest,
  response: Response,
): boolean {
  if (request.validStatuses?.includes(response.status)) return true;
  if (response.status === 401) throw new NativeApiError("authorization", 401);
  if (response.status === 403) throw new NativeApiError("permission", 403);
  if (response.status === 429) throw new NativeApiError("rate-limit", 429);
  if (!response.ok || response.redirected)
    throw new NativeApiError("response", response.status);
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
    if (answeredByStatus(request, response)) return {};
    const body = await reply(response, controller.signal);
    transport.assertCurrent();
    if (controller.signal.aborted) throw new NativeApiError("network");
    return body;
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    if (error instanceof EgressDenied) throw new NativeApiError("deployment");
    throw new NativeApiError("network");
  } finally {
    try {
      // HTTP refusal and post-header withdrawal never enter the JSON reader.
      // Close that original unread body before its request deadline retires.
      await cancelUnreadResponse(response);
    } finally {
      clearTimeout(deadline);
      request.signal?.removeEventListener("abort", abort);
    }
  }
}
