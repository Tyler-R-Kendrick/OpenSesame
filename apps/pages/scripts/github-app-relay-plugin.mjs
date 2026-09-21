import {
  handleGitBackupPut,
  handleGitBackupPutOptions,
} from "../../connect-backend/git-backup-put.mjs";
/**
 * Dev-only GitHub App relay on the Vite origin.
 *
 * Same handlers as `apps/connect-backend` so localhost needs no separate
 * `VITE_CONNECT_CALLBACK_BASE` — production GitHub Pages / Vercel set that
 * base to the deployed relay instead.
 */
import {
  handleGithubAppPutContents,
  handleGithubAppWebhook,
  handleGithubAppWebhookPending,
} from "../../connect-backend/github-app-contents.mjs";
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

function writeRelayOutcome(res, outcome) {
  res.statusCode = outcome.status;
  for (const [key, value] of Object.entries(outcome.headers)) {
    res.setHeader(key, value);
  }
  res.end(outcome.body);
}

function handleRelayError(res, error) {
  res.statusCode = 500;
  res.end(error instanceof Error ? error.message : "Relay failed.");
}

async function handleGitBackupRoute(req, res) {
  const origin = req.headers.origin ?? "";
  if (req.method === "OPTIONS") {
    writeRelayOutcome(res, handleGitBackupPutOptions(origin));
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
  writeRelayOutcome(res, await handleGitBackupPut(body, origin));
}

async function handleGithubAppJsonRoute(req, res, path) {
  const origin = req.headers.origin ?? "";
  if (req.method === "OPTIONS") {
    writeRelayOutcome(res, handleGithubAppConvertOptions(origin));
    return;
  }
  if (path === "/api/github-app/webhook-pending" && req.method === "GET") {
    writeRelayOutcome(res, handleGithubAppWebhookPending(origin));
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
      : path === "/api/github-app/put-contents"
        ? await handleGithubAppPutContents(body, origin)
        : path === "/api/github-app/installations"
          ? await handleGithubAppInstallations(body, origin)
          : await handleGithubAppConvert(body, origin);
  writeRelayOutcome(res, outcome);
}

const GITHUB_APP_JSON_PATHS = new Set([
  "/api/github-app/convert",
  "/api/github-app/installations",
  "/api/github-app/lookup",
  "/api/github-app/put-contents",
  "/api/github-app/webhook-pending",
]);

function attachGithubAppRelay(server) {
  server.middlewares.use((req, res, next) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "";
    if (path === "/api/github-app/callback") {
      writeRelayOutcome(res, handleGithubAppCallback(url, requestHost(req)));
      return;
    }
    if (path === "/api/github-app/webhook") {
      void (async () => {
        let body = {};
        try {
          body = await readBody(req);
        } catch {
          body = {};
        }
        writeRelayOutcome(res, handleGithubAppWebhook(body, req.headers));
      })().catch((error) => handleRelayError(res, error));
      return;
    }
    if (path === "/api/git-backup/put") {
      void handleGitBackupRoute(req, res).catch((error) =>
        handleRelayError(res, error),
      );
      return;
    }
    if (!GITHUB_APP_JSON_PATHS.has(path)) {
      next();
      return;
    }
    void handleGithubAppJsonRoute(req, res, path).catch((error) =>
      handleRelayError(res, error),
    );
  });
}

export function githubAppRelayPlugin() {
  return {
    name: "github-app-relay",
    configureServer(server) {
      attachGithubAppRelay(server);
    },
  };
}
