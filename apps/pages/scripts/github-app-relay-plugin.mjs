/**
 * Dev-only GitHub App relay on the Vite origin.
 *
 * Same handlers as `apps/connect-backend` so localhost needs no separate
 * `VITE_CONNECT_CALLBACK_BASE` — production GitHub Pages / Vercel set that
 * base to the deployed relay instead.
 */
import {
  handleGithubAppCallback,
  handleGithubAppConvert,
  handleGithubAppConvertOptions,
  handleGithubAppInstallations,
  handleGithubAppLookup,
} from "../../connect-backend/github-app.mjs";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function requestHost(req) {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${req.headers.host ?? "localhost"}`;
}

/** @returns {import("vite").Plugin} */
export function githubAppRelayPlugin() {
  return {
    name: "github-app-relay",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        const path = url.split("?")[0] ?? "";
        if (path === "/api/github-app/callback") {
          const outcome = handleGithubAppCallback(url, requestHost(req));
          res.statusCode = outcome.status;
          for (const [key, value] of Object.entries(outcome.headers)) {
            res.setHeader(key, value);
          }
          res.end(outcome.body);
          return;
        }
        if (
          path !== "/api/github-app/convert" &&
          path !== "/api/github-app/installations" &&
          path !== "/api/github-app/lookup"
        ) {
          next();
          return;
        }
        void (async () => {
          const origin = req.headers.origin ?? "";
          if (req.method === "OPTIONS") {
            const outcome = handleGithubAppConvertOptions(origin);
            res.statusCode = outcome.status;
            for (const [key, value] of Object.entries(outcome.headers)) {
              res.setHeader(key, value);
            }
            res.end(outcome.body);
            return;
          }
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("POST only.");
            return;
          }
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "invalid_json" }));
            return;
          }
          const outcome =
            path === "/api/github-app/lookup"
              ? await handleGithubAppLookup(body, origin)
              : path === "/api/github-app/installations"
                ? await handleGithubAppInstallations(body, origin)
                : await handleGithubAppConvert(body, origin);
          res.statusCode = outcome.status;
          for (const [key, value] of Object.entries(outcome.headers)) {
            res.setHeader(key, value);
          }
          res.end(outcome.body);
        })().catch((error) => {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : "Relay failed.");
        });
      });
    },
  };
}
