/**
 * Loopback HTTP helpers shared by the in-process relay and the live join page.
 */

const MAX_BYTES = 16 * 1024 * 1024;

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
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, {
    "content-type":
      type ?? (typeof body === "string" ? "text/plain" : "application/json"),
    "cache-control": "no-store",
  });
  response.end(payload);
}

export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

export function closeServer(server) {
  return new Promise((done, fail) => {
    server.close((error) => (error ? fail(error) : done()));
  });
}
