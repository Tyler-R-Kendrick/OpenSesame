import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { z } from "zod";
import type { AiConnectionTransport } from "./types.js";

export type CapturedAiRequest = {
  path: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: string;
};
export async function aiHttpFixture(
  reply: (request: CapturedAiRequest, response: ServerResponse) => void,
) {
  const requests: CapturedAiRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const captured = {
        path: request.url ?? "",
        method: request.method ?? "",
        headers: request.headers,
        body,
      };
      requests.push(captured);
      reply(captured, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const lifetime = new AbortController();
  const transport: AiConnectionTransport = {
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
    fetch,
  };
  return {
    baseUrl: `http://127.0.0.1:${address.port}/custom/v1`,
    requests,
    transport,
    lifetime,
    async close() {
      lifetime.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
