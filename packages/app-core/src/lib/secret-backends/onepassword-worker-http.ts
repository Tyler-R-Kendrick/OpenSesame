import type { BoundaryValue } from "@opensesame/os-domain";
import { secretBackendUrl } from "./http.js";
import {
  ONEPASSWORD_HTTP_MAX_BYTES,
  ONEPASSWORD_HTTP_MAX_PENDING,
  ONEPASSWORD_HTTP_SESSION_REQUESTS,
  OnePasswordFetchMessageSchema,
  type OnePasswordFetchRequest,
  type OnePasswordFetchResult,
  OnePasswordFetchResultSchema,
  onePasswordNetworkError,
  readOnePasswordBytes,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendTransport } from "./transport.js";

function accountOrigin(value: string): string {
  const url = secretBackendUrl(value);
  if (url.pathname !== "/") throw onePasswordNetworkError();
  return url.origin;
}

function requestUrl(request: OnePasswordFetchRequest, origin: string): URL {
  const url = new URL(request.url);
  const forbidden = request.headers.some(([name]) =>
    /^(cookie2?|host|origin|referer|connection|content-length|proxy-.*|sec-.*)$/i.test(
      name,
    ),
  );
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    forbidden
  )
    throw onePasswordNetworkError();
  if (["GET", "HEAD"].includes(request.method) && request.body.byteLength > 0)
    throw onePasswordNetworkError();
  return url;
}

function fetchResponse(
  transport: SecretBackendTransport,
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  check: () => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(onePasswordNetworkError());
    signal.addEventListener("abort", abort, { once: true });
    const failed = () => {
      signal.removeEventListener("abort", abort);
      reject(onePasswordNetworkError());
    };
    try {
      check();
      void transport.fetch(url.href, init).then((response) => {
        signal.removeEventListener("abort", abort);
        try {
          check();
          resolve(response);
        } catch {
          void response.body?.cancel().catch(onePasswordNetworkError);
          reject(onePasswordNetworkError());
        }
      }, failed);
    } catch {
      failed();
    }
  });
}

class OnePasswordWorkerHttp {
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<number, AbortController>();
  private readonly seen = new Set<number>();
  private readonly origin: string;
  constructor(
    expectedAccountOrigin: string,
    private readonly transport: SecretBackendTransport,
    private readonly deadlineMs: number,
    private readonly onClose?: () => void,
  ) {
    this.origin = accountOrigin(expectedAccountOrigin);
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 60_000
    )
      throw onePasswordNetworkError();
    transport.signal.addEventListener("abort", this.close, { once: true });
  }
  assertCurrent = () => {
    this.lifetime.signal.throwIfAborted();
    this.transport.signal.throwIfAborted();
    this.transport.assertCurrent();
    this.lifetime.signal.throwIfAborted();
    this.transport.signal.throwIfAborted();
  };
  close = () => {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.pending.clear();
    this.transport.signal.removeEventListener("abort", this.close);
    try {
      this.onClose?.();
    } catch {
      // Closure is final even if the owning loader's cleanup also fails.
      return;
    }
  };
  private forward = async (
    request: OnePasswordFetchRequest,
    controller: AbortController,
  ) => {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      this.transport.signal,
      controller.signal,
      AbortSignal.timeout(this.deadlineMs),
    ]);
    const check = () => {
      signal.throwIfAborted();
      this.assertCurrent();
    };
    check();
    const url = requestUrl(request, this.origin);
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    };
    if (!["GET", "HEAD"].includes(request.method))
      init.body = request.body.slice().buffer;
    const response = await fetchResponse(
      this.transport,
      url,
      init,
      signal,
      check,
    );
    try {
      check();
      if (
        response.redirected ||
        response.status < 200 ||
        (response.status >= 300 &&
          response.status < 400 &&
          response.status !== 304) ||
        response.url !== url.href
      )
        throw onePasswordNetworkError();
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d+$/.test(length) ||
          !Number.isSafeInteger(Number(length)) ||
          Number(length) > ONEPASSWORD_HTTP_MAX_BYTES)
      )
        throw onePasswordNetworkError();
      const body = await readOnePasswordBytes(response.body, signal, check);
      check();
      return OnePasswordFetchResultSchema.parse({
        type: "fetch-result",
        id: request.id,
        ok: true,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: [...response.headers.entries()],
        body,
      });
    } catch {
      void response.body?.cancel().catch(onePasswordNetworkError);
      throw onePasswordNetworkError();
    }
  };
  receive(
    value: BoundaryValue,
    post: (result: OnePasswordFetchResult) => void,
  ): boolean {
    const parsed = OnePasswordFetchMessageSchema.safeParse(value);
    if (!parsed.success) return false;
    try {
      this.assertCurrent();
    } catch {
      this.close();
      return false;
    }
    const message = parsed.data;
    if (message.type === "fetch-cancel") {
      this.pending.get(message.id)?.abort();
      this.pending.delete(message.id);
      return true;
    }
    if (this.seen.has(message.id)) return false;
    if (
      this.seen.size >= ONEPASSWORD_HTTP_SESSION_REQUESTS ||
      this.pending.size >= ONEPASSWORD_HTTP_MAX_PENDING
    ) {
      this.close();
      return false;
    }
    this.seen.add(message.id);
    const controller = new AbortController();
    this.pending.set(message.id, controller);
    const settle = (result: OnePasswordFetchResult) => {
      try {
        this.assertCurrent();
        if (this.pending.get(message.id) !== controller) return;
        this.pending.delete(message.id);
        post(result);
      } catch {
        this.close();
      }
    };
    void this.forward(message, controller).then(settle, () =>
      settle({
        type: "fetch-result",
        id: message.id,
        ok: false,
      }),
    );
    return true;
  }
}

/** Unactivated broker; the future loader must also guard its non-network posts. */
export function createOnePasswordWorkerHttp(
  expectedAccountOrigin: string,
  transport: SecretBackendTransport,
  deadlineMs = 20_000,
  onClose?: () => void,
) {
  return new OnePasswordWorkerHttp(
    expectedAccountOrigin,
    transport,
    deadlineMs,
    onClose,
  );
}
