import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { test } from "vitest";

test("only the local authorization popup may retain a cross-origin opener", async () => {
  const server = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, preTransformRequests: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert(address && Object.hasOwn(address, "port"));
    for (const [path, policy] of [
      ["identity/authorize?state=test", "unsafe-none"],
      ["vault", "same-origin"],
      ["identity", "same-origin"],
      ["identity/authorize-extra", "same-origin"],
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/OpenSesame/${path}`,
      );
      assert.equal(response.headers.get("cross-origin-opener-policy"), policy);
      assert.equal(
        response.headers.get("cross-origin-embedder-policy"),
        "require-corp",
      );
      await response.body?.cancel();
    }
  } finally {
    await server.close();
  }
});
