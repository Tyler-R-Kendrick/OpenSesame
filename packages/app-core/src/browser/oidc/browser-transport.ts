import { identityEndpoint } from "../../lib/identity-connections-schema.js";
/** Browser CORS/trust, captured for one verified OIDC ceremony; no node or global registration. */
import {
  localNetworkFetchSeams,
  targetAddressSpaceFor,
  withTargetAddressSpace,
} from "../../lib/local-network-fetch.js";
import type {
  IdentityBrowserNodeOwner,
  IdentityHTTPPort,
} from "../../lib/tailscale/browser-node-identity-port.js";
export type BrowserOidcHTTP = Readonly<{
  transport: IdentityHTTPPort;
  retire: () => Promise<void>;
}>;
type ReaderLease = Readonly<
  Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel">
>;
class BrowserOidcCarrier {
  readonly stop = new AbortController();
  readonly originalFetch = globalThis.fetch;
  readonly ownerSignal: AbortSignal;
  readonly assertOwner: () => void;
  readonly signal: AbortSignal;
  readonly requests = new Set<Promise<void>>();
  readonly readers = new Set<ReaderLease>();
  draining: Promise<void> | null = null;
  retired = false;
  constructor(readonly owner: IdentityBrowserNodeOwner) {
    this.ownerSignal = owner.signal;
    this.assertOwner = owner.assertCurrent;
    this.signal = AbortSignal.any([this.ownerSignal, this.stop.signal]);
  }
  check(): void {
    this.signal.throwIfAborted();
    if (
      this.retired ||
      globalThis.fetch !== this.originalFetch ||
      this.owner.signal !== this.ownerSignal ||
      this.owner.assertCurrent !== this.assertOwner
    )
      throw new Error("Original browser OIDC HTTP owner changed.");
    this.assertOwner.call(this.owner);
    this.signal.throwIfAborted();
    if (globalThis.fetch !== this.originalFetch)
      throw new Error("Original browser OIDC fetch changed.");
  }
  assertCurrent = (): void => {
    try {
      this.check();
    } catch (error) {
      this.retired = true;
      this.stop.abort(error);
      throw error;
    }
  };
  adoptReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
    let cancelling: Promise<void> | null = null;
    const release = () => {
      if (this.readers.delete(lease)) reader.releaseLock();
    };
    const finish = () => {
      if (!cancelling) release();
    };
    const lease: ReaderLease = {
      cancel: (reason) => {
        if (cancelling) return cancelling;
        let begin = () => {};
        cancelling = new Promise<void>((resolve, reject) => {
          begin = () => {
            void (async () => {
              try {
                await reader.cancel(reason);
              } finally {
                release();
              }
            })().then(resolve, reject);
          };
        });
        begin();
        return cancelling;
      },
    };
    this.readers.add(lease);
    return { finish, cancel: lease.cancel };
  }
  response(response: Response): Response {
    if (
      response.redirected ||
      ["opaque", "opaqueredirect"].includes(response.type)
    )
      throw new Error(
        "Browser OIDC response bypassed CORS or redirect refusal.",
      );
    const reader = response.body?.getReader();
    if (!reader) return response;
    const { finish, cancel } = this.adoptReader(reader);
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          this.assertCurrent();
          const part = await reader.read();
          this.assertCurrent();
          if (part.done) {
            finish();
            controller.close();
          } else controller.enqueue(part.value);
        } catch (error) {
          try {
            await cancel(error);
          } finally {
            finish();
            controller.error(error);
          }
        }
      },
      cancel: async (reason) => {
        try {
          await cancel(reason);
        } finally {
          finish();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  fetch: typeof fetch = (input, init) => {
    let complete = () => {};
    const lifetime = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.requests.add(lifetime);
    const operation = this.performFetch(input, init);
    const finished = () => {
      this.requests.delete(lifetime);
      complete();
    };
    void operation.then(finished, finished);
    return operation;
  };
  async performFetch(
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    this.assertCurrent();
    const request = new Request(input, init);
    if (
      !identityEndpoint(request.url) ||
      !["GET", "POST"].includes(request.method)
    )
      throw new Error("Invalid browser OIDC HTTP target or method.");
    if (
      (targetAddressSpaceFor(request.url) &&
        !localNetworkFetchSeams.eligible()) ||
      request.headers.has("X-OpenSesame-Operator")
    )
      throw new DOMException(
        "This browser deployment cannot use local operator authority.",
        "SecurityError",
      );
    const pending = this.originalFetch.call(
      globalThis,
      request,
      withTargetAddressSpace(request.url, {
        signal: AbortSignal.any([request.signal, this.signal]),
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }),
    );
    const response = await pending;
    try {
      this.assertCurrent();
      return this.response(response);
    } catch (error) {
      try {
        await response.body?.cancel();
      } catch {
        // Cleanup cannot replace the original request failure.
      }
      throw error;
    }
  }
  retire = (): Promise<void> => {
    if (this.draining) return this.draining;
    this.retired = true;
    let begin = () => {};
    this.draining = new Promise<void>((resolve, reject) => {
      begin = () => {
        void (async () => {
          const pending = [...this.readers].map((reader) => reader.cancel());
          this.stop.abort();
          const cancellations = await Promise.allSettled(pending);
          // Full operations include refusal cleanup after headers and settle only after body cancellation.
          await Promise.allSettled([...this.requests]);
          const failed = cancellations.find(
            (result) => result.status === "rejected",
          );
          if (failed?.status === "rejected") throw failed.reason;
        })().then(resolve, reject);
      };
    });
    begin();
    return this.draining;
  };
}
/** Origins use the browser's real trust/CORS enforcement, never a claimed native socket grant. */
export function captureBrowserOidcHTTP(
  owner: IdentityBrowserNodeOwner,
): BrowserOidcHTTP {
  const carrier = new BrowserOidcCarrier(owner);
  carrier.assertCurrent();
  const transport: IdentityHTTPPort = Object.freeze({
    signal: carrier.signal,
    assertCurrent: carrier.assertCurrent,
    fetch: carrier.fetch,
    supportsNativeOrigin: (origin) => {
      carrier.assertCurrent();
      return (
        identityEndpoint(origin) !== null && new URL(origin).origin === origin
      );
    },
  });
  return Object.freeze({ transport, retire: carrier.retire });
}
