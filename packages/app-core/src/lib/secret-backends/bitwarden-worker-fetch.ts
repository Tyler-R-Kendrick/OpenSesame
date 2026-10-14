import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type BitwardenFetchRequest,
  BitwardenFetchRequestSchema,
  BitwardenFetchResultSchema,
} from "./bitwarden-worker-protocol.js";
import type { SecretBackendFetch } from "./types.js";

type PendingFetch = {
  resolve(response: Response): void;
  reject(error: Error): void;
};
/** reqwest reads the response URL; constructed Responses otherwise expose an empty URL. */
class BitwardenNetworkResponse extends Response {
  readonly #url: string;
  constructor(body: ArrayBuffer | null, init: ResponseInit, url: string) {
    super(body, init);
    this.#url = url;
  }
  override get url(): string {
    return this.#url;
  }
}
/** The owned worker's only network port forwards requests to its parent's captured transport. */
export function createBitwardenWorkerFetch(
  post: (request: BitwardenFetchRequest) => void,
) {
  const pending = new Map<number, PendingFetch>();
  let sequence = 0;
  const fetcher: SecretBackendFetch = async (input, init) => {
    const request = new Request(input, init);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? ""
        : await request.text();
    const message = BitwardenFetchRequestSchema.parse({
      type: "fetch",
      id: ++sequence,
      url: request.url,
      method: request.method,
      headers: [...request.headers.entries()],
      body,
    });
    return new Promise<Response>((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
      post(message);
    });
  };
  return {
    fetch: fetcher,
    receive(value: BoundaryValue): boolean {
      const parsed = BitwardenFetchResultSchema.safeParse(value);
      if (!parsed.success) return false;
      const result = parsed.data;
      const operation = pending.get(result.id);
      if (!operation) return true;
      pending.delete(result.id);
      if (!result.ok)
        operation.reject(new Error("The backend network request failed."));
      else {
        const body = [204, 205, 304].includes(result.status)
          ? null
          : result.body.slice().buffer;
        operation.resolve(
          new BitwardenNetworkResponse(
            body,
            {
              status: result.status,
              statusText: result.statusText,
              headers: result.headers,
            },
            result.url,
          ),
        );
      }
      return true;
    },
    close() {
      for (const operation of pending.values())
        operation.reject(new Error("The isolated session ended."));
      pending.clear();
    },
  };
}
