/**
 * Disposable Vite IIFE bundle of duress runtime modules for real-browser QA.
 * Output lands under scripts/duress/.fixture-dist/ (gitignored via .gitignore if needed).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesRoot = path.resolve(here, "..", "..");
const outDir = path.join(here, ".fixture-dist");
const entry = path.join(here, "fixture-entry.ts");

export async function buildDuressFixture() {
  fs.mkdirSync(outDir, { recursive: true });
  await build({
    configFile: false,
    root: pagesRoot,
    logLevel: "warn",
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      target: "es2022",
      lib: {
        entry,
        name: "DuressQa",
        formats: ["iife"],
        fileName: () => "duress-qa-fixture.js",
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  const js = path.join(outDir, "duress-qa-fixture.js");
  if (!fs.existsSync(js)) {
    throw new Error(`fixture build missing ${js}`);
  }
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Duress QA fixture</title>
</head>
<body>
  <h1>Duress QA fixture</h1>
  <p>Disposable harness page — not a production surface.</p>
  <script src="./duress-qa-fixture.js"></script>
</body>
</html>
`;
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  return { outDir, js, html: path.join(outDir, "index.html") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await buildDuressFixture();
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
