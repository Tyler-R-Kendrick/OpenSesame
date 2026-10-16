import type { BoundaryValue } from "@opensesame/os-domain";
import {
  ONEPASSWORD_HTTP_MAX_PENDING,
  type OnePasswordFetchMessage,
  OnePasswordFetchRequestSchema,
  OnePasswordFetchResultSchema,
  onePasswordNetworkError,
  readOnePasswordBytes,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendFetch } from "./types.js";

type Pending = {
  request: Request;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  abort: () => void;
  posted: boolean;
};

/** A constructed Response otherwise hides the URL required by the SDK. */
class OnePasswordNetworkResponse extends Response {
  constructor(
    body: ArrayBuffer | null,
    init: ResponseInit,
    private readonly sourceUrl: string,
  ) {
    super(body, init);
  }
  override get url(): string {
    return this.sourceUrl;
  }
}

class OnePasswordWorkerFetch {
  private readonly pending = new Map<number, Pending>();
  private readonly lifetime = new AbortController();
  private sequence = 0;
  constructor(
    private readonly post: (message: OnePasswordFetchMessage) => void,
  ) {}
  private remove = (id: number) => {
    const operation = this.pending.get(id);
    if (operation)
      operation.request.signal.removeEventListener("abort", operation.abort);
    this.pending.delete(id);
    return operation;
  };
  close = () => {
    this.lifetime.abort();
    for (const id of this.pending.keys())
      this.remove(id)?.reject(onePasswordNetworkError());
  };
  private cancel = (id: number) => {
    const operation = this.remove(id);
    operation?.reject(onePasswordNetworkError());
    if (!operation?.posted) return;
    try {
      this.post({ type: "fetch-cancel", id });
    } catch {
      this.close();
    }
  };
  private serialize = async (id: number, operation: Pending) => {
    const check = () => {
      this.lifetime.signal.throwIfAborted();
      operation.request.signal.throwIfAborted();
      if (this.pending.get(id) !== operation) throw onePasswordNetworkError();
    };
    const body = await readOnePasswordBytes(
      operation.request.body,
      AbortSignal.any([this.lifetime.signal, operation.request.signal]),
      check,
    );
    check();
    const message = OnePasswordFetchRequestSchema.parse({
      type: "fetch",
      id,
      url: operation.request.url,
      method: operation.request.method,
      headers: [...operation.request.headers.entries()],
      body,
    });
    check();
    operation.posted = true;
    this.post(message);
  };
  fetch: SecretBackendFetch = async (input, init) => {
    try {
      this.lifetime.signal.throwIfAborted();
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      if (
        this.sequence === Number.MAX_SAFE_INTEGER ||
        this.pending.size >= ONEPASSWORD_HTTP_MAX_PENDING
      )
        throw onePasswordNetworkError();
      const id = ++this.sequence;
      return await new Promise<Response>((resolve, reject) => {
        const operation: Pending = {
          request,
          resolve,
          reject,
          abort: () => this.cancel(id),
          posted: false,
        };
        this.pending.set(id, operation);
        request.signal.addEventListener("abort", operation.abort, {
          once: true,
        });
        void this.serialize(id, operation).catch(() => this.cancel(id));
      });
    } catch {
      throw onePasswordNetworkError();
    }
  };
  receive(value: BoundaryValue): boolean {
    const parsed = OnePasswordFetchResultSchema.safeParse(value);
    if (!parsed.success) return false;
    const result = parsed.data;
    const operation = this.remove(result.id);
    if (!operation) return true;
    try {
      this.lifetime.signal.throwIfAborted();
      operation.request.signal.throwIfAborted();
      if (!result.ok || result.url !== operation.request.url)
        throw onePasswordNetworkError();
      const body =
        operation.request.method === "HEAD" ||
        [204, 205, 304].includes(result.status)
          ? null
          : result.body.slice().buffer;
      operation.resolve(
        new OnePasswordNetworkResponse(
          body,
          {
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
          },
          result.url,
        ),
      );
    } catch {
      operation.reject(onePasswordNetworkError());
    }
    return true;
  }
}

/** Worker-local fetch: all network authority stays in the captured main port. */
export function createOnePasswordWorkerFetch(
  post: (message: OnePasswordFetchMessage) => void,
) {
  return new OnePasswordWorkerFetch(post);
}
