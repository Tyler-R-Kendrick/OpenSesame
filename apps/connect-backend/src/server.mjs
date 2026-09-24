import { createServer } from "node:http";
import { handleCallback } from "./callback.mjs";
import {
  handleGitBackupPut,
  handleGitBackupPutOptions,
} from "./git-backup-put.mjs";
import {
  handleGithubAppPutContents,
  handleGithubAppWebhook,
  handleGithubAppWebhookPending,
} from "./github-app-contents.mjs";
import {
  handleGithubAppCallback,
  handleGithubAppConvert,
  handleGithubAppConvertOptions,
  handleGithubAppInstallations,
  handleGithubAppLookup,
} from "./github-app.mjs";
import { handleManage, readJsonBody, readRawBody } from "./manage.mjs";

const port = Number(process.env.PORT ?? 8789);
const host = process.env.HOST ?? "127.0.0.1";

const MANAGE_PATHS = new Set([
  "/api/connect/connectors",
  "/api/connect/authorize",
  "/api/connect/revoke",
]);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://relay.invalid");
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const requestHost = `${proto}://${req.headers.host ?? "localhost"}`;
  const origin = req.headers.origin ?? "";

  void (async () => {
    if (url.pathname === "/api/connect/callback") {
      const outcome = handleCallback(req.url ?? "/", requestHost);
      res.writeHead(outcome.status, outcome.headers);
      res.end(outcome.body);
      return;
    }
    if (url.pathname === "/api/github-app/callback") {
      const outcome = handleGithubAppCallback(req.url ?? "/", requestHost);
      res.writeHead(outcome.status, outcome.headers);
      res.end(outcome.body);
      return;
    }
    if (url.pathname === "/api/github-app/convert") {
      if (req.method === "OPTIONS") {
        const outcome = handleGithubAppConvertOptions(origin);
        res.writeHead(outcome.status, outcome.headers);
        res.end(outcome.body);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        res.end("POST only.");
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const outcome = await handleGithubAppConvert(body, origin);
      res.writeHead(outcome.status, outcome.headers);
      res.end(outcome.body);
      return;
    }
    if (url.pathname === "/api/github-app/webhook") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        res.end("POST only.");
        return;
      }
      let rawBody = "";
      let body = {};
      try {
        rawBody = await readRawBody(req);
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        body = {};
      }
      const outcome = await handleGithubAppWebhook(body, req.headers, rawBody);
      res.writeHead(outcome.status, outcome.headers);
      res.end(outcome.body);
      return;
    }
    if (
      url.pathname === "/api/github-app/installations" ||
      url.pathname === "/api/github-app/installation-repos" ||
      url.pathname === "/api/github-app/create-repo" ||
      url.pathname === "/api/github-app/lookup" ||
      url.pathname === "/api/github-app/put-contents" ||
      url.pathname === "/api/github-app/webhook-pending"
    ) {
      if (req.method === "OPTIONS") {
        const outcome = handleGithubAppConvertOptions(origin);
        res.writeHead(outcome.status, outcome.headers);
        res.end(outcome.body);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        res.end("POST only.");
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const { handleGithubAppCreateRepo, handleGithubAppInstallationRepos } =
        await import("./github-app-repos.mjs");
      const outcome =
        url.pathname === "/api/github-app/lookup"
          ? await handleGithubAppLookup(body, origin)
          : url.pathname === "/api/github-app/put-contents"
            ? await handleGithubAppPutContents(body, origin)
            : url.pathname === "/api/github-app/installation-repos"
              ? await handleGithubAppInstallationRepos(body, origin)
              : url.pathname === "/api/github-app/create-repo"
                ? await handleGithubAppCreateRepo(body, origin)
                : url.pathname === "/api/github-app/webhook-pending"
                  ? await handleGithubAppWebhookPending(body, origin)
                  : await handleGithubAppInstallations(body, origin);
      res.writeHead(outcome.status, outcome.headers);
      res.end(outcome.body);
      return;
    }

    if (url.pathname === "/api/git-backup/put") {
      if (req.method === "OPTIONS") {
        const outcome = handleGitBackupPutOptions(origin);
        res.writeHead(outcome.status, outcome.headers);
        res.end(outcome.body);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        res.end("POST only.");
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const outcome = await handleGitBackupPut(body, origin);
      res.writeHead(outcome.status, outcome.headers);
      res.end(outcome.body);
      return;
    }
    if (MANAGE_PATHS.has(url.pathname)) {
      let body = {};
      if (req.method !== "GET" && req.method !== "OPTIONS") {
        try {
          body = await readJsonBody(req);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { code: "invalid_request", message: "Body must be JSON." },
            }),
          );
          return;
        }
      }
      const outcome = await handleManage({
        method: req.method ?? "GET",
        path: url.pathname,
        origin,
        authorization: req.headers.authorization ?? "",
        requestHost,
        body,
      });
      res.writeHead(outcome.status, outcome.headers);
      res.end(outcome.body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Nothing here but the Connect relay.");
  })().catch((error) => {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : "Relay failed.");
  });
});

server.listen(port, host, () => {
  console.log(`connect-backend on http://${host}:${port}`);
});
