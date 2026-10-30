// @vitest-environment node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, createServer } from "vite";
import { test } from "vitest";

// A fresh native module graph keeps Vitest/setup imports from warming Zod's
// cache or initializing its global configuration before the probe.
const PROBE = `
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
let probes = 0;
globalThis.Function = new Proxy(globalThis.Function, {
  construct() {
    probes += 1;
    throw new EvalError("Content Security Policy forbids eval");
  },
});
if (process.argv[2]) runInThisContext(readFileSync(process.argv[2], "utf8"));
const { z } = await import(process.argv[1]);
const parsed = z.object({ name: z.string() }).parse({ name: "Ada" });
console.log(JSON.stringify({ probes, parsed }));
`;

function probe(withBootstrap) {
  // App-core owns the browser's Zod 4 dependency; Pages also resolves Zod 3.
  const appRequire = createRequire(
    new URL("../../../packages/app-core/package.json", import.meta.url),
  );
  const zod = pathToFileURL(
    appRequire.resolve("zod").replace(/index\.cjs$/, "index.js"),
  ).href;
  const args = ["--input-type=module", "--eval", PROBE, zod];
  if (withBootstrap)
    args.push(
      fileURLToPath(
        new URL("../public/browser-schema-config.js", import.meta.url),
      ),
    );
  return JSON.parse(
    execFileSync(process.execPath, args, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    }),
  );
}

test("the classic bootstrap prevents Zod's eval probe before the module graph", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const bootstrap = '<script src="/browser-schema-config.js"></script>';
  assert.ok(html.includes(bootstrap));
  assert.ok(html.indexOf(bootstrap) < html.indexOf('type="module"'));
  assert.ok(probe(false).probes > 0, "the unconfigured module probes eval");
  assert.deepEqual(probe(true), { probes: 0, parsed: { name: "Ada" } });
});

function startupReferences(html) {
  const script = html.match(
    /<script src="([^"]*browser-schema-config\.js)"><\/script>/,
  );
  const icon = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/);
  assert(script && icon);
  return { script: script[1], icon: icon[1] };
}

test.each(["/", "/OpenSesame/", "/nested/vault/"])(
  "serves blocking startup assets with base %s exactly once",
  async (base) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "opensesame-schema-vite-"));
    const server = await createServer({
      root: fileURLToPath(new URL("../", import.meta.url)),
      cacheDir,
      configFile: false,
      base,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      server: { host: "127.0.0.1", preTransformRequests: false },
    });
    try {
      await server.listen(0);
      const origin = server.resolvedUrls.local[0];
      const response = await fetch(new URL(base, origin));
      assert.equal(response.status, 200);
      const html = await response.text();
      const refs = startupReferences(html);
      assert.equal(refs.script, `${base}browser-schema-config.js`);
      assert.equal(refs.icon, `${base}icon-192.png`);
      const script = await fetch(new URL(refs.script, origin));
      assert.equal(script.status, 200);
      assert.match(await script.text(), /__zod_globalConfig\.jitless = true/);
      const icon = await fetch(new URL(refs.icon, origin));
      assert.equal(icon.status, 200);
      assert.equal(icon.headers.get("content-type"), "image/png");
    } finally {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);

test.each(["/", "/OpenSesame/", "/nested/vault/"])(
  "builds blocking startup assets with base %s exactly once",
  async (base) => {
    const area = await mkdtemp(join(tmpdir(), "opensesame-schema-bootstrap-"));
    try {
      await mkdir(join(area, "public"));
      await mkdir(join(area, "src"));
      for (const name of ["browser-schema-config.js", "icon-192.png"])
        await copyFile(
          new URL(`../public/${name}`, import.meta.url),
          join(area, "public", name),
        );
      const html = readFileSync(
        new URL("../index.html", import.meta.url),
        "utf8",
      );
      await writeFile(
        join(area, "index.html"),
        html.replace("/src/main.tsx", "/src/main.mjs"),
      );
      await writeFile(
        join(area, "src/main.mjs"),
        "globalThis.startupFixture = true;",
      );
      const result = await build({
        root: area,
        configFile: false,
        base,
        logLevel: "silent",
        build: { write: false, minify: false },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const index = outputs
        .flatMap((output) => output.output)
        .find((file) => file.fileName === "index.html");
      assert(index && index.type === "asset");
      const built = index.source.toString();
      assert.deepEqual(startupReferences(built), {
        script: `${base}browser-schema-config.js`,
        icon: `${base}icon-192.png`,
      });
      assert(
        built.indexOf("browser-schema-config.js") <
          built.indexOf('type="module"'),
      );
    } finally {
      await rm(area, { recursive: true, force: true });
    }
  },
);
