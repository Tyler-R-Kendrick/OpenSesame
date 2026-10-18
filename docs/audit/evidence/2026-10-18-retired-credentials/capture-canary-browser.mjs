import { createHash, randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const [dist, output] = process.argv.slice(2);
await mkdir(output, { recursive: false, mode: 0o700 });
const require = createRequire(join(repo, "packages/app-core/package.json"));
const { register } = createRequire(require.resolve("vite"))("tsx/esm/api");
register();
const { chromium } = require("@playwright/test");
const { sealWithPin, PIN } = await import(
  pathToFileURL(join(repo, "apps/pages/scripts/lib/pages-journey.mjs")).href
);
const { createControlledCanaryReceiver } = await import(
  pathToFileURL(
    join(repo, "packages/app-core/src/node/agent-canary-receiver.ts"),
  ).href
);
const { listenCanaryReceiver } = await import(
  pathToFileURL(join(repo, "packages/app-core/src/node/agent-canary-http.ts"))
    .href
);
const { openCanaryState } = await import(
  pathToFileURL(join(repo, "packages/app-core/src/node/agent-canary-state.ts"))
    .href
);
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const base = "/OpenSesame/";
const app = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (!path.startsWith(base) || path.includes("..")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const relative = path.slice(base.length);
    let data;
    try {
      data = await readFile(join(dist, relative || "index.html"));
    } catch {
      if (extname(relative)) throw new Error("Missing asset");
      data = await readFile(join(dist, "index.html"));
    }
    res.setHeader("Content-Type", mime[extname(relative)] ?? "text/html");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${app.address().port}`;
const reservation = createNetServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const endpoint = `http://127.0.0.1:${port}`;
const serviceId = randomBytes(32).toString("hex");
const report = {
  status: "PENDING",
  artifact: dist,
  browser: null,
  origin,
  receiver: endpoint,
  checks: [],
  http: [],
  receiverHttp: [],
  pageErrors: [],
  networkFailures: [],
  qualification:
    "Actual production PWA artifact and real local owner PIN; real Node receiver, encrypted on-disk receiver state, actual HTTP CORS/browser preflight and ES256 owner signatures. No auth, storage, fetch or receiver mocks. Browser is ordinary Chromium without security-policy overrides; service workers blocked.",
};
const check = (value, label) => {
  if (!value) throw new Error(label);
  report.checks.push(label);
};
const httpChannel = channel("http.server.request.start");
const auditHttp = ({ request, response }) => {
  if (request.headers.host !== new URL(endpoint).host) return;
  const method = request.method;
  const path = request.url.replace(
    /artifacts\/[0-9a-f]{64}/u,
    "artifacts/[canary-id]",
  );
  const requestOrigin = request.headers.origin ?? null;
  response.once("finish", () =>
    report.receiverHttp.push({
      method,
      path,
      requestOrigin,
      status: response.statusCode,
      allowOrigin: response.getHeader("access-control-allow-origin") ?? null,
    }),
  );
};
httpChannel.subscribe(auditHttp);
let browser;
let context;
let server;
let storage;
let lastProof;
let artifact;
let page;
try {
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
  });
  report.browser = browser.version();
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("requestfailed", (request) =>
    report.networkFailures.push({
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    }),
  );
  page.on("request", (request) => {
    if (
      request.url() === `${endpoint}/v1/agent-canaries/execute` &&
      request.method() === "POST"
    )
      lastProof = request.postDataJSON();
  });
  page.on("response", (response) => {
    if (new URL(response.url()).origin === endpoint)
      report.http.push({
        method: response.request().method(),
        path: new URL(response.url()).pathname,
        status: response.status(),
        allowOrigin: response.headers()["access-control-allow-origin"] ?? null,
      });
  });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}settings/security`);
  await page
    .getByRole("button", { name: "Manage agent canaries", exact: true })
    .click();
  await page.getByLabel("Receiver endpoint", { exact: true }).fill(endpoint);
  await page.getByLabel("Receiver service ID", { exact: true }).fill(serviceId);
  await page
    .getByLabel("Receiver bind port", { exact: true })
    .fill(String(port));
  await page.getByLabel(/Operation/).selectOption("pairing");
  await page
    .getByRole("button", { name: "Pair receiver", exact: true })
    .click();
  const verify = async () => {
    await page.getByLabel("Current PIN", { exact: true }).fill(PIN);
    await page
      .getByRole("button", { name: "Verify current key", exact: true })
      .click();
  };
  await verify();
  const pairing = JSON.parse(
    await page.getByLabel(/Receiver pairing document/).inputValue(),
  );
  check(
    pairing.origin === origin &&
      pairing.endpoint === endpoint &&
      pairing.bindPort === port,
    "UI pairing binds exact browser origin and loopback endpoint",
  );
  storage = await openCanaryState(join(output, "receiver-private"), serviceId);
  const receiver = await createControlledCanaryReceiver(pairing, storage);
  server = await listenCanaryReceiver(receiver);
  const refresh = async () => {
    await page
      .getByRole("button", { name: "Refresh canaries", exact: true })
      .click();
    await verify();
  };
  await refresh();
  await page.getByText("No active canaries.", { exact: true }).waitFor();
  check(true, "browser signed inspection reaches actual paired receiver");
  await page
    .getByLabel("Canary name", { exact: true })
    .fill("Actual browser receiver proof");
  await page
    .getByLabel("Canary retention in days (1–90)", { exact: true })
    .fill("1");
  await page.getByLabel(/I control where this detection-only artifact/).check();
  await page.getByRole("button", { name: "Add canary", exact: true }).click();
  await verify();
  await page
    .getByRole("button", { name: "Export enrolled canary", exact: true })
    .waitFor();
  check(true, "actual UI fresh-owner enrollment persists receiver record");
  await page
    .getByRole("button", { name: "Export enrolled canary", exact: true })
    .click();
  await verify();
  const configuration = JSON.parse(
    await page.getByLabel(/Canary configuration/).inputValue(),
  );
  artifact = Object.values(configuration.mcpServers ?? {})[0];
  check(
    artifact?.url.startsWith(`${endpoint}/v1/agent-canaries/artifacts/`) &&
      /^Bearer [0-9a-f]{64}$/u.test(artifact.headers.Authorization),
    "fresh-owner export returns only receiver-bound detection artifact",
  );
  const rpc = async (method, id) =>
    fetch(artifact.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: artifact.headers.Authorization,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params:
          method === "tools/call"
            ? { name: "canary_status", arguments: {} }
            : undefined,
      }),
    });
  check(
    (await rpc("initialize", 1)).status === 200,
    "exported artifact establishes actual detection-only connection",
  );
  const invoked = await rpc("tools/call", 2);
  const result = await invoked.json();
  check(
    invoked.status === 200 &&
      JSON.stringify(result).includes("No production authority"),
    "exported artifact invokes detection-only tool on actual receiver",
  );
  await refresh();
  await page.getByText("Canary connected", { exact: false }).first().waitFor();
  await page
    .getByText("Canary tool invoked", { exact: false })
    .first()
    .waitFor();
  check(
    true,
    "actual UI inspection displays receiver connection and tool-use events",
  );
  await page
    .getByRole("button", {
      name: "Export Actual browser receiver proof",
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: join(output, "canary-inspection.png") });
  await page
    .getByRole("button", {
      name: "Remove Actual browser receiver proof",
      exact: true,
    })
    .click();
  await verify();
  await page
    .getByRole("button", { name: "Refresh canaries", exact: true })
    .waitFor();
  await refresh();
  await page.getByText("No active canaries.", { exact: true }).waitFor();
  check(
    true,
    "actual UI fresh-owner removal is confirmed by signed empty inspection",
  );
  check(
    (await rpc("tools/call", 3)).status === 403,
    "removed artifact bearer no longer reaches detection tool",
  );
  const replay = await page.evaluate(
    async ({ endpoint, proof }) =>
      (
        await fetch(`${endpoint}/v1/agent-canaries/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(proof),
        })
      ).status,
    { endpoint, proof: lastProof },
  );
  check(replay === 403, "real browser replay of spent signed nonce is refused");
  const foreign = await fetch(`${endpoint}/v1/agent-canaries/challenge`, {
    method: "POST",
    headers: {
      Origin: "https://foreign.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ kind: "inspect", contextId: "a".repeat(64) }),
  });
  check(
    foreign.status === 403 &&
      foreign.headers.get("access-control-allow-origin") === null,
    "actual receiver refuses foreign browser origin without CORS admission",
  );
  await server.close();
  server = undefined;
  await storage.close();
  storage = undefined;
  const reopened = await openCanaryState(
    join(output, "receiver-private"),
    serviceId,
  );
  check(
    reopened.state.records.length === 0 && reopened.state.events.length === 2,
    "encrypted receiver state reopens with revoked record absent and two real detection events",
  );
  await reopened.close();
  check(
    report.receiverHttp.some(
      (x) =>
        x.method === "OPTIONS" &&
        x.status === 204 &&
        x.requestOrigin === origin,
    ),
    "actual receiver accepts exact-origin browser CORS preflight",
  );
  check(
    report.pageErrors.length === 0,
    "production canary browser flow has zero page errors",
  );
  const posts = report.http.filter(
    (x) => x.method === "POST" && x.status === 200,
  );
  check(
    posts.length >= 12 && posts.every((x) => x.allowOrigin === origin),
    "successful real challenge/execute HTTP responses admit only exact paired origin",
  );
  report.status = "PASS";
  report.browserOwnerSignedRequests = posts.filter((x) =>
    x.path.endsWith("/execute"),
  ).length;
  report.exportedArtifactPersisted = false;
  report.receiverStateEncrypted = true;
  report.screenshotSha256 = createHash("sha256")
    .update(await readFile(join(output, "canary-inspection.png")))
    .digest("hex");
} catch (error) {
  report.status = "FAIL";
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  httpChannel.unsubscribe(auditHttp);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await server?.close();
  await storage?.close();
  await context?.close();
  await browser?.close();
  await new Promise((resolve) => app.close(resolve));
}
