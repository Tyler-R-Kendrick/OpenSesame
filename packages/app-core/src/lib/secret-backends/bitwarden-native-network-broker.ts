import { type BoundaryValue, ownBytes } from "@opensesame/os-domain";
import { bitwardenNativeNetworkPolicy } from "./bitwarden-native-network-policy.js";
import {
  NativeFetchCancel,
  type NativeFetchReply,
  NativeFetchRequest,
} from "./bitwarden-native-network-protocol.js";
import type { SecretBackendTransport } from "./transport.js";
import { SecretBackendError } from "./types.js";

type NetworkPort = { send(reply: NativeFetchReply): void; fail(): void };
function ended(): never {
  throw new SecretBackendError(
    "network",
    "The captured native account network operation ended.",
  );
}
function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
function validateResponse(response: Response, maximum: number): void {
  const media =
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
  const length = response.headers.get("content-length");
  if (
    !/^application\/(?:json|[a-z0-9!#$%&'*+.^_`|~-]+\+json)$/.test(media) ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
  ) {
    cancelBody(response);
    ended();
  }
}
async function body(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  check: () => void,
): Promise<Uint8Array> {
  validateResponse(response, maximum);
  const reader = response.body?.getReader();
  if (!reader) return ended();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    check();
    for (;;) {
      const part = await reader.read();
      check();
      if (part.done) {
        complete = true;
        break;
      }
      size += part.value.byteLength;
      if (!part.value.byteLength || size > maximum || chunks.length >= 65536)
        return ended();
      chunks.push(new Uint8Array(part.value));
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) abort();
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}
async function execute(
  request: NativeFetchRequest,
  maximum: number,
  transport: SecretBackendTransport,
  signal: AbortSignal,
): Promise<NativeFetchReply> {
  const check = () => {
    transport.assertCurrent();
    if (signal.aborted) ended();
  };
  check();
  const response = await transport.fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body || undefined,
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  try {
    check();
    if (response.redirected || response.status < 200 || response.status > 599)
      return ended();
    let bytes = new Uint8Array();
    if (!response.ok || response.status === 204 || maximum === 0)
      cancelBody(response);
    else bytes = ownBytes(await body(response, maximum, signal, check));
    check();
    const contentType = response.headers.get("content-type");
    return {
      type: "native-fetch-reply",
      id: request.id,
      ok: true,
      status: response.status,
      statusText: "",
      headers: contentType ? [["content-type", contentType]] : [],
      body: bytes,
    };
  } catch (error) {
    cancelBody(response);
    throw error;
  }
}
/** One worker's approved activation, with fixed routes, bounded bodies, and physical aborts. */
export function createBitwardenNativeNetworkBroker(
  port: NetworkPort,
  transport: SecretBackendTransport,
  settings: { baseUrl: string; identityUrl: string },
) {
  const approve = bitwardenNativeNetworkPolicy(
    settings.baseUrl,
    settings.identityUrl,
  );
  const pending = new Map<
    number,
    { controller: AbortController; sync: boolean }
  >();
  let lastId = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    transport.signal.removeEventListener("abort", close);
    for (const operation of pending.values()) operation.controller.abort();
    pending.clear();
  };
  const fail = () => {
    close();
    port.fail();
  };
  transport.signal.addEventListener("abort", close, { once: true });
  if (transport.signal.aborted) close();
  const dispatch = async (request: NativeFetchRequest, maximum: number) => {
    const controller = new AbortController();
    pending.set(request.id, { controller, sync: maximum === 64 * 1024 * 1024 });
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const result = await execute(
        request,
        maximum,
        transport,
        AbortSignal.any([controller.signal, transport.signal]),
      );
      if (!closed && !controller.signal.aborted) port.send(result);
      else if (result.ok) result.body.fill(0);
    } catch {
      if (!closed)
        port.send({ type: "native-fetch-reply", id: request.id, ok: false });
    } finally {
      clearTimeout(timer);
      pending.delete(request.id);
    }
  };
  return {
    close,
    receive(value: BoundaryValue): boolean {
      const cancellation = NativeFetchCancel.safeParse(value);
      if (cancellation.success) {
        pending.get(cancellation.data.id)?.controller.abort();
        return true;
      }
      const parsed = NativeFetchRequest.safeParse(value);
      if (!parsed.success) return false;
      if (closed) return true;
      try {
        transport.assertCurrent();
        const request = parsed.data;
        const maximum = approve(request);
        if (
          request.id <= lastId ||
          pending.size >= 4 ||
          (maximum === 64 * 1024 * 1024 &&
            [...pending.values()].some((row) => row.sync))
        ) {
          fail();
          return true;
        }
        lastId = request.id;
        void dispatch(request, maximum);
      } catch {
        fail();
      }
      return true;
    },
  };
}
