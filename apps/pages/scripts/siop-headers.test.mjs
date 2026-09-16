import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { test } from "vitest";
import { crossOriginOpenerPolicy } from "../src/lib/opener-policy.js";

const base = "/OpenSesame/";

test(
  "SIOP consent keeps a cross-origin opener; other identity routes stay isolated",
  { timeout: 60_000 },
  async () => {
    const cases = [
      ["identity/siop?client_id=test", "unsafe-none"],
      ["identity/authorize?state=test", "unsafe-none"],
      ["vault", "same-origin"],
      ["identity", "same-origin"],
      ["identity/siop-extra", "same-origin"],
    ];
    for (const [path, policy] of cases) {
      const pathname = path.split("?")[0];
      assert.equal(
        crossOriginOpenerPolicy(`${base}${pathname}`, base),
        policy,
        `opener-policy for ${pathname}`,
      );
    }

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
      for (const [path, policy] of cases) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}${base}${path}`,
        );
        assert.equal(
          response.headers.get("cross-origin-opener-policy"),
          policy,
        );
        assert.equal(
          response.headers.get("cross-origin-embedder-policy"),
          "require-corp",
        );
        await response.body?.cancel();
      }
    } finally {
      await server.close();
    }
  },
);
