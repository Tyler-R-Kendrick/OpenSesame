/** Loopback HTTP shell with bounded requests and exact owner browser-origin admission. */
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { CONTROLLED_CANARY_REQUEST_BYTES } from "../lib/agent-canaries/controlled-receiver-contract.js";
import { handleCanaryArtifact } from "./agent-canary-artifact.js";
import type { createControlledCanaryReceiver } from "./agent-canary-receiver.js";
async function readBody(request: IncomingMessage): Promise<BoundaryValue> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > CONTROLLED_CANARY_REQUEST_BYTES)
      throw new Error("Receiver request too large.");
    chunks.push(bytes);
  }
  return overlapCast(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
function send<Value>(response: ServerResponse, status: number, value: Value) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
type Receiver = Pick<
  Awaited<ReturnType<typeof createControlledCanaryReceiver>>,
  "pairing" | "challenge" | "execute" | "observe"
>;
function receiverHandler(receiver: Receiver) {
  const endpoint = new URL(receiver.pairing.endpoint);
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (
        request.headers.host !== endpoint.host &&
        request.headers.host !== `127.0.0.1:${receiver.pairing.bindPort}`
      )
        throw new Error("Foreign receiver host.");
      const path = request.url ?? "";
      if (path.startsWith("/v1/agent-canaries/artifacts/")) {
        await handleCanaryArtifact(receiver, request, response, {
          read: readBody,
          send,
        });
        return;
      }
      if (request.headers.origin !== receiver.pairing.origin)
        throw new Error("Foreign receiver origin.");
      response.setHeader(
        "Access-Control-Allow-Origin",
        receiver.pairing.origin,
      );
      response.setHeader("Vary", "Origin");
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "POST");
        response.setHeader("Access-Control-Allow-Headers", "content-type");
        response.writeHead(204);
        response.end();
        return;
      }
      if (
        request.method !== "POST" ||
        request.headers["content-type"]?.split(";")[0] !== "application/json"
      )
        throw new Error("Invalid receiver request.");
      const value = await readBody(request);
      if (path === "/v1/agent-canaries/challenge")
        send(response, 200, await receiver.challenge(value));
      else if (path === "/v1/agent-canaries/execute")
        send(response, 200, await receiver.execute(value));
      else send(response, 404, { error: "unavailable" });
    } catch {
      send(response, 403, { error: "Receiver request refused." });
    }
  };
  return handle;
}
export async function listenCanaryReceiver(receiver: Receiver) {
  let pending = Promise.resolve();
  const handle = receiverHandler(receiver);
  const server = createServer((request, response) => {
    pending = pending.then(() => handle(request, response));
  });
  server.maxConnections = 32;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(receiver.pairing.bindPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: receiver.pairing.bindPort,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
