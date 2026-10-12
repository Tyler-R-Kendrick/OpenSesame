/**
 * Loopback HTTP helpers shared by the in-process relay and the live join page.
 */
import { z } from "zod";
import { isString } from "../../../../scripts/lib/json-boundary.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const addressSchema = z.object({ port: z.number().int().nonnegative() });

export function listeningPort(server) {
  const address = addressSchema.safeParse(server.address());
  return address.success ? address.data.port : 0;
}

export function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error("too_large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export function send(response, status, body, type) {
  const payload = isString(body) ? body : JSON.stringify(body);
  response.writeHead(status, {
    "content-type":
      type ?? (isString(body) ? "text/plain" : "application/json"),
    "cache-control": "no-store",
  });
  response.end(payload);
}

export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = listeningPort(server);
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

export function closeServer(server) {
  return new Promise((done, fail) => {
    server.close((error) => (error ? fail(error) : done()));
  });
}
