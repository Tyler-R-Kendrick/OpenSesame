/** Original OPFS, device key and Web Locks; only the provider is synthetic. */
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = await realpath(process.argv[2] ?? process.cwd());
const require = createRequire(join(repo, "package.json"));
const { chromium } = require("@playwright/test");
const { createServer } = await import(require.resolve("vite"));
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM ?? chromium.executablePath();
await access(executablePath);
const scratch = await mkdtemp(join(tmpdir(), "mcp-realm-proof-"));
const config = {
  configFile: false,
  appType: "custom",
  root: repo,
  cacheDir: join(scratch, "vite-cache"),
  logLevel: "error",
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    fs: { allow: [repo] },
  },
  resolve: {
    alias: [
      {
        find: /^@opensesame\/app-core\/(.*)\.js$/,
        replacement: `${repo}/packages/app-core/src/$1`,
      },
      {
        find: /^@opensesame\/vault-core$/,
        replacement: `${repo}/packages/vault-core/src/index.ts`,
      },
      {
        find: /^@opensesame\/vault-core\/(.*)\.js$/,
        replacement: `${repo}/packages/vault-core/src/$1`,
      },
    ],
  },
  esbuild: { target: "es2022" },
  optimizeDeps: {
    entries: [join(repo, "apps/pages/test/mcp-cross-realm/entry.ts")],
    esbuildOptions: { target: "es2022" },
  },
};
function insist(condition, message) {
  if (!condition) throw new Error(message);
}
async function bounded(label, work) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function invoke(page, moduleUrl, name, args = []) {
  return bounded(
    name,
    page.evaluate(
      async ({ moduleUrl, name, args }) => {
        const fixture = await import(moduleUrl);
        return fixture[name](...args);
      },
      { moduleUrl, name, args },
    ),
  );
}
async function refuses(page, moduleUrl, name, args) {
  const refusal = await bounded(
    name,
    page.evaluate(
      async ({ moduleUrl, name, args }) => {
        const fixture = await import(moduleUrl);
        try {
          await fixture[name](...args);
          return { name: "accepted", code: "" };
        } catch (error) {
          return { name: error?.name, code: error?.code };
        }
      },
      { moduleUrl, name, args },
    ),
  );
  insist(
    refusal.name === "NativeMcpAuthError" && refusal.code === "pending",
    `${name} did not reject with the expected pending error`,
  );
}
async function page(context, origin) {
  const result = await bounded("open page", context.newPage());
  await result.goto(`${origin}/mcp-cross-realm.html`);
  return result;
}
async function checkFence(owner, other, moduleUrl, id, state, stage) {
  await bounded(
    "load fixture",
    owner.evaluate(async (url) => {
      globalThis.__mcpRealmStatus = (await import(url)).status;
    }, moduleUrl),
  );
  await invoke(owner, moduleUrl, "startFinish", [id, state, stage]);
  await owner.waitForFunction(
    (stage) => {
      const current = globalThis.__mcpRealmStatus();
      if (current.failure)
        throw new Error(`Fixture failed: ${current.failure}`);
      return current.stage === stage;
    },
    stage,
    { timeout: 15000 },
  );
  const status = await invoke(owner, moduleUrl, "status");
  insist(
    status.tokenPosts === (stage === "submitting" ? 1 : 0),
    `Unexpected token submission count: ${status.tokenPosts}`,
  );
  await invoke(other, moduleUrl, "sync");
  const before = await invoke(other, moduleUrl, "inspect", [id]);
  insist(before.durability === "persistent", "Fixture storage is not durable");
  const intent = before.recovery.find((entry) => entry.phase === "exchange");
  insist(intent?.submission === stage, "Wrong durable submission state");
  await refuses(other, moduleUrl, "guide", [id]);
  await refuses(other, moduleUrl, "prepare", [id]);
  await refuses(other, moduleUrl, "attest", [id, intent.id, before.revision]);
  return intent.id;
}
async function crashOwner(context, owner) {
  const crash = owner.waitForEvent("crash", { timeout: 10000 });
  const cdp = await context.newCDPSession(owner);
  void cdp.send("Page.crash").catch(() => {});
  await crash;
}
async function checkRecovery(survivor, moduleUrl, id, intentId, stage) {
  await invoke(survivor, moduleUrl, "setup");
  await invoke(survivor, moduleUrl, "sync");
  await invoke(survivor, moduleUrl, "prepare", [id]);
  await invoke(survivor, moduleUrl, "sync");
  const after = await invoke(survivor, moduleUrl, "inspect", [id]);
  insist(
    after.durability === "persistent" && after.clientPresent,
    "Provider client was not retained",
  );
  if (stage === "prepared") {
    insist(
      !after.recovery.some((entry) => entry.id === intentId),
      "Prepared exchange survived renderer death",
    );
    insist(
      after.recovery.some((entry) => entry.kind === "registration"),
      "Registration cleanup obligation was lost",
    );
    return;
  }
  insist(
    after.recovery.some(
      (entry) => entry.id === intentId && entry.submission === "submitting",
    ),
    "Submitted exchange was lost after renderer death",
  );
  const guide = await invoke(survivor, moduleUrl, "guide", [id]);
  insist(guide.canConfirm === false, "Uncertain submission became attestable");
  await refuses(survivor, moduleUrl, "attest", [id, intentId, guide.revision]);
  await invoke(survivor, moduleUrl, "sync");
  const final = await invoke(survivor, moduleUrl, "inspect", [id]);
  insist(
    final.recovery.some(
      (entry) => entry.id === intentId && entry.submission === "submitting",
    ),
    "Refused attestation changed uncertain recovery",
  );
}
async function stageCase(stage, origin, moduleUrl) {
  const context = await chromium.launchPersistentContext(
    join(scratch, `profile-${stage}`),
    { executablePath, headless: true, serviceWorkers: "block" },
  );
  try {
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort("blockedbyclient"),
    );
    const owner = await page(context, origin);
    const other = await page(context, origin);
    await invoke(owner, moduleUrl, "setup");
    const { id, state } = await invoke(owner, moduleUrl, "start");
    await invoke(other, moduleUrl, "setup");
    await invoke(other, moduleUrl, "sync");
    const intentId = await checkFence(
      owner,
      other,
      moduleUrl,
      id,
      state,
      stage,
    );
    await crashOwner(context, owner);
    const survivor = await page(context, origin);
    await checkRecovery(survivor, moduleUrl, id, intentId, stage);
    console.log(
      `PASS ${stage}: real browser lock and durable recovery after renderer crash`,
    );
  } finally {
    await bounded("close browser", context.close());
  }
}
let server;
try {
  server = await createServer(config);
  server.middlewares.use((req, res, next) => {
    if (req.url !== "/mcp-cross-realm.html") return next();
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>MCP cross-realm fixture</title>");
  });
  await server.listen();
  const localAddress = server.resolvedUrls?.local[0];
  if (!localAddress) throw new Error("Fixture server did not bind");
  const origin = new URL(localAddress).origin;
  const moduleUrl = `${origin}/apps/pages/test/mcp-cross-realm/entry.ts`;
  await stageCase("prepared", origin, moduleUrl);
  await stageCase("submitting", origin, moduleUrl);
} finally {
  try {
    await server?.close();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
