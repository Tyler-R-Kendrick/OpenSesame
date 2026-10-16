import { once } from "node:events";
import { type IncomingHttpHeaders, createServer } from "node:http";
import { z } from "zod";

export type CapturedSecretRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
};
export type FixtureReply = { status?: number; body?: string };
export type SecretFixtureHandler = (
  request: CapturedSecretRequest,
) => FixtureReply | Promise<FixtureReply>;

/** Independent socket boundary: adapters use native fetch rather than mocked success returns. */
export async function secretHttpFixture(
  handler: SecretFixtureHandler,
  port = 0,
) {
  const requests: CapturedSecretRequest[] = [];
  const preflights: CapturedSecretRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      preflights.push({
        method: "OPTIONS",
        path: request.url ?? "/",
        headers: request.headers,
        body: "",
      });
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers":
          request.headers["access-control-request-headers"] ??
          "Authorization,Content-Type",
        "Access-Control-Allow-Private-Network": "true",
      });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const captured = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(captured);
    try {
      const reply = await handler(captured);
      response.writeHead(reply.status ?? 200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      response.end(reply.body);
    } catch {
      response.writeHead(500);
      response.end('{"message":"Fixture rejected request"}');
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number() }).parse(server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    preflights,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
