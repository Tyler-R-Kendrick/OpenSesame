import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
const repo = await realpath(process.argv[2] ?? process.cwd());
const output = resolve(process.argv[3] ?? "");
if (!process.argv[3] || !output.startsWith("/tmp/"))
  throw new Error("An explicit private /tmp output is required.");
await mkdir(output, { recursive: false });
const require = createRequire(join(repo, "package.json"));
const { chromium } = require("@playwright/test");
const { createServer } = await import(require.resolve("vite"));
const inputRoots = [
  "packages/app-core/src",
  "packages/vault-core/src",
  "apps/pages/test/original-browser-physical",
];
const fixedInputs = [
  "package.json",
  "package-lock.json",
  "apps/pages/package.json",
  "packages/app-core/package.json",
  "packages/vault-core/package.json",
];
async function inputs() {
  const paths = [...fixedInputs];
  async function scan(directory) {
    for (const entry of await readdir(join(repo, directory), {
      withFileTypes: true,
    })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile() && /\.(?:ts|tsx|mjs|json)$/.test(path))
        paths.push(path);
      else if (entry.isSymbolicLink())
        throw new Error("Unexpected source input symlink.");
    }
  }
  for (const root of inputRoots) await scan(root);
  return Promise.all(
    paths.sort().map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(join(repo, path)))
        .digest("hex"),
    })),
  );
}
const before = await inputs();
await writeFile(
  join(output, "inputs-before.json"),
  JSON.stringify(before, null, 2),
);
const report = {
  status: "PENDING",
  browser: null,
  cases: [],
  sourceUnchanged: false,
  qualification:
    "Actual native OPFS/IDB/Web Locks and ordinary legacy password/AEAD fixture only; no modern full-factor/REAL admission or native app acceptance. Source closure includes Core, vault kernel, fixture and lock/manifests, not all installed external bytes.",
};
let server;
const contexts = new Set();
async function closeOwnedResources() {
  const closed = await Promise.allSettled([
    ...[...contexts].map((current) => current.close()),
    Promise.resolve().then(() => server?.close()),
  ]);
  const failures = closed
    .filter((outcome) => outcome.status === "rejected")
    .map((outcome) => outcome.reason);
  if (failures.length)
    throw new AggregateError(failures, "Native resource cleanup failed.");
}
try {
  server = await createServer({
    configFile: false,
    appType: "custom",
    root: repo,
    cacheDir: join(output, "vite-cache"),
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      fs: { allow: [repo] },
    },
    // Reused dependency trees must never redirect the selected source checkout.
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
      esbuildOptions: { target: "es2022" },
      entries: [
        join(
          repo,
          "apps/pages/test/original-browser-physical/browser-entry.ts",
        ),
      ],
    },
  });
  server.middlewares.use((req, res, next) => {
    if (req.url !== "/physical-proof.html") return next();
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Original native storage fixture</title>");
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || !Object.hasOwn(address, "port"))
    throw new Error("Owned loopback listener unavailable.");
  const origin = `http://127.0.0.1:${address.port}`;
  const moduleUrl = `${origin}/apps/pages/test/original-browser-physical/browser-entry.ts`;
  async function context(name) {
    const native = await chromium.launchPersistentContext(
      join(output, "profiles", name),
      {
        executablePath: "/usr/bin/chromium",
        headless: true,
        serviceWorkers: "block",
      },
    );
    contexts.add(native);
    const currentBrowser = native.browser();
    if (!currentBrowser)
      throw new Error("Native browser identity is unavailable.");
    report.browser = await currentBrowser.version();
    return native;
  }
  async function page(context) {
    const next = await context.newPage();
    await next.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort("blockedbyclient"),
    );
    next.on("pageerror", (error) => {
      report.status = "FAIL";
      report.cases.push({ name: "unhandled", error: error.name });
    });
    await next.goto(`${origin}/physical-proof.html`);
    return next;
  }
  const invoke = (target, name, input = "") =>
    target.evaluate(
      async ({ moduleUrl, name, input }) => {
        const fixture = await import(moduleUrl);
        return fixture.run(name, input);
      },
      { moduleUrl, name, input },
    );
  async function one(name) {
    const current = await context(name);
    try {
      report.cases.push({
        name,
        result: await invoke(await page(current), name),
      });
    } finally {
      await current.close();
      contexts.delete(current);
    }
  }
  for (const name of [
    "retired-factor-lifecycle",
    "retired-lifecycle",
    "deleted-registry",
    "restored-registry",
    "orphan-header",
    "orphan-body",
    "catalogue-after-capture-drift",
    "orphan-retired-record",
    "empty-profile",
    "roundtrip",
    "no-initialization",
    "key-replacement",
    "provider-replacement",
    "root-replacement",
    "catalogue-drift",
    "all-causes-bound",
  ])
    await one(name);
  const loss = await context("missing-key");
  try {
    const target = await page(loss);
    const seeded = await invoke(target, "seed-key-loss");
    await target.reload();
    report.cases.push({
      name: "missing-key",
      result: await invoke(target, "missing-key", seeded.before),
    });
  } finally {
    await loss.close();
    contexts.delete(loss);
  }
  const shared = await context("shared-cas");
  try {
    const a = await page(shared);
    const b = await page(shared);
    await Promise.all([
      invoke(a, "prepare-cas", "A"),
      invoke(b, "prepare-cas", "B"),
    ]);
    const outcomes = await Promise.all([
      invoke(a, "commit-cas"),
      invoke(b, "commit-cas"),
    ]);
    if (outcomes.filter((outcome) => outcome.committed).length !== 1)
      throw new Error("Native CAS did not yield exactly one winner.");
    const first = await invoke(a, "read-cas");
    const second = await invoke(b, "read-cas");
    if (first.value !== second.value)
      throw new Error("Native documents did not read the same CAS winner.");
    report.cases.push({
      name: "two-document-shared-cas",
      committed: 1,
      checks: [...first.checks, ...second.checks],
    });
  } finally {
    await shared.close();
    contexts.delete(shared);
  }
  if (report.status !== "FAIL") report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  await writeFile(
    join(output, "private-failure.txt"),
    String(error?.stack ?? error),
  );
} finally {
  try {
    await closeOwnedResources();
  } catch (error) {
    report.status = "FAIL";
    await writeFile(join(output, "private-cleanup-failure.txt"), String(error));
  }
  const after = await inputs();
  await writeFile(
    join(output, "inputs-after.json"),
    JSON.stringify(after, null, 2),
  );
  report.sourceUnchanged = JSON.stringify(before) === JSON.stringify(after);
  if (!report.sourceUnchanged) report.status = "FAIL";
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
