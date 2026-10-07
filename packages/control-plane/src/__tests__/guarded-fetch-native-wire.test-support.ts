import http, {
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { vi } from "vitest";

export type WireRequest = {
  method: string | undefined;
  path: string | undefined;
  host: string | undefined;
  bodyHex: string;
  contentType: string | undefined;
  contentLength: string | undefined;
};

type ResponseCallback = (response: IncomingMessage) => void;

function respond(
  request: IncomingMessage,
  response: ServerResponse,
  seen: WireRequest[],
): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const received: WireRequest = {
      method: request.method,
      path: request.url,
      host: request.headers.host,
      bodyHex: Buffer.concat(chunks).toString("hex"),
      contentType: request.headers["content-type"],
      contentLength: request.headers["content-length"],
    };
    seen.push(received);
    if (request.url === "/bytes") {
      response.end("éééé");
    } else if (request.url === "/redirect") {
      response.writeHead(302, { location: "/followed" });
      response.end();
    } else if (request.url === "/empty") {
      response.writeHead(204, { "x-metadata": "empty" });
      response.end();
    } else {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-metadata", ["first", "second"]);
      response.end(JSON.stringify(received));
    }
  });
}

export async function openPinnedWireFixture() {
  const seen: WireRequest[] = [];
  const requestedOptions: RequestOptions[] = [];
  const server = http.createServer({}, (request, response) =>
    respond(request, response, seen),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The wire fixture did not bind a TCP port.");
  }
  const port = address.port;
  const originalRequest = http.request;
  function routed(
    options: RequestOptions | string | URL,
    callback?: ResponseCallback,
  ): ClientRequest;
  function routed(
    url: string | URL,
    options: RequestOptions,
    callback?: ResponseCallback,
  ): ClientRequest;
  function routed(
    input: RequestOptions | string | URL,
    optionsOrCallback?: RequestOptions | ResponseCallback,
    _callback?: ResponseCallback,
  ): ClientRequest {
    if (
      typeof input === "string" ||
      input instanceof URL ||
      typeof optionsOrCallback !== "function"
    ) {
      throw new Error(
        "The default pinned transport changed its native request shape.",
      );
    }
    requestedOptions.push(input);
    return originalRequest(
      { ...input, hostname: "127.0.0.1", port },
      optionsOrCallback,
    );
  }
  const route = vi.spyOn(http, "request").mockImplementation(routed);
  return {
    seen,
    requestedOptions,
    async close() {
      route.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
