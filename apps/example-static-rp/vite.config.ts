import { resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";

const repoRoot = resolve(import.meta.dirname, "../..");
const issuer =
  process.env.OPENSESAME_ISSUER?.replace(/\/+$/u, "") ??
  "http://127.0.0.1:8788";

/** Map /opensesame/callback → callback.html (no RP backend). */
function callbackRewrite(): Plugin {
  return {
    name: "opensesame-callback-rewrite",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        if (
          url === "/opensesame/callback" ||
          url.startsWith("/opensesame/callback?")
        ) {
          const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
          req.url = `/opensesame/callback.html${qs}`;
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        if (
          url === "/opensesame/callback" ||
          url.startsWith("/opensesame/callback?")
        ) {
          const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
          req.url = `/opensesame/callback.html${qs}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname, "public"),
  define: {
    __OPENSESAME_ISSUER__: JSON.stringify(issuer),
  },
  build: {
    target: ["es2022", "chrome100", "firefox100", "safari15"],
  },
  server: {
    port: 4101,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  preview: {
    port: 4101,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@opensesame/sdk-browser": resolve(
        repoRoot,
        "packages/sdk-browser/src/index.ts",
      ),
    },
  },
  plugins: [callbackRewrite()],
});
