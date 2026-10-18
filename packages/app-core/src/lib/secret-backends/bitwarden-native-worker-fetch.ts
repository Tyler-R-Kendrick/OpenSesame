import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type NativeFetchCancel,
  NativeFetchReply,
  NativeFetchRequest,
} from "./bitwarden-native-network-protocol.js";
import { SecretBackendError, type SecretBackendFetch } from "./types.js";

type PendingFetch = {
  resolve(response: Response): void;
  reject(error: SecretBackendError): void;
  detach(): void;
};
function ended(): SecretBackendError {
  return new SecretBackendError(
    "network",
    "The captured native Bitwarden network operation ended.",
  );
}
function message(
  input: Parameters<SecretBackendFetch>[0],
  init: RequestInit | undefined,
  id: number,
): NativeFetchRequest {
  const target =
    input instanceof URL
      ? input.href
      : z.string().min(1).max(8192).parse(input);
  const body =
    init?.body === undefined || init.body === null
      ? ""
      : init.body instanceof URLSearchParams
        ? init.body.toString()
        : z
            .string()
            .max(8 * 1024 * 1024)
            .parse(init.body);
  if (new TextEncoder().encode(body).length > 8 * 1024 * 1024) throw ended();
  return NativeFetchRequest.parse({
    type: "native-fetch",
    id,
    url: target,
    method: init?.method ?? "GET",
    headers: [...new Headers(init?.headers).entries()],
    body,
  });
}
/** Worker-side fetch has no ambient network path; the main owner approves every request. */
export function createBitwardenNativeWorkerFetch(
  post: (value: NativeFetchRequest | NativeFetchCancel) => void,
  owner: AbortSignal,
) {
  const pending = new Map<number, PendingFetch>();
  let sequence = 0;
  let closed = false;
  const cancel = (id: number) => {
    try {
      post({ type: "native-fetch-cancel", id });
    } catch {
      return;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    owner.removeEventListener("abort", close);
    for (const [id, request] of pending) {
      request.detach();
      request.reject(ended());
      cancel(id);
    }
    pending.clear();
  };
  owner.addEventListener("abort", close, { once: true });
  if (owner.aborted) close();
  const fetcher: SecretBackendFetch = async (input, init) => {
    if (closed || owner.aborted || init?.signal?.aborted || pending.size >= 4)
      throw ended();
    let request: NativeFetchRequest;
    try {
      request = message(input, init, ++sequence);
    } catch {
      throw ended();
    }
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => {
        const held = pending.get(request.id);
        if (!held) return;
        pending.delete(request.id);
        held.detach();
        reject(ended());
        cancel(request.id);
      };
      const detach = () => signal?.removeEventListener("abort", abort);
      pending.set(request.id, { resolve, reject, detach });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted || owner.aborted) {
          abort();
          return;
        }
        post(request);
      } catch {
        pending.delete(request.id);
        detach();
        reject(ended());
      }
    });
  };
  return {
    fetch: fetcher,
    close,
    receive(value: BoundaryValue): boolean {
      const parsed = NativeFetchReply.safeParse(value);
      if (!parsed.success) return false;
      const reply = parsed.data;
      const held = pending.get(reply.id);
      if (!held) return true;
      pending.delete(reply.id);
      held.detach();
      if (closed || owner.aborted || !reply.ok) {
        held.reject(ended());
        return true;
      }
      try {
        held.resolve(
          new Response(reply.body.length ? reply.body : null, {
            status: reply.status,
            statusText: reply.statusText,
            headers: reply.headers,
          }),
        );
      } catch {
        held.reject(ended());
      }
      return true;
    },
  };
}
