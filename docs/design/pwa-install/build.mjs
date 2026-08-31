#!/usr/bin/env node
/**
 * Compose the artboards from `_style.css` + `parts/<Name>.html`.
 *
 * Every artboard carries the whole design system in its own `<helmet>` — a
 * Design Component is one self-contained file, and the canvas has no shared
 * stylesheet. Repeating 600 lines of tokens by hand six times is how six
 * artboards drift into six different greys, so the shared block is written
 * once here and stamped into each `.dc.html` at build time.
 *
 *   node build.mjs
 *
 * `parts/<Name>.html` holds only what differs: the markup inside `<x-dc>`,
 * optionally followed by a `<script data-dc-script …>` logic block. The
 * generated `<Name>.dc.html` files are what `seed-canvas.mjs` reads, and they
 * are committed — an `--extract` round trip has to land on real files.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const style = readFileSync(join(here, "_style.css"), "utf8").trimEnd();

const parts = readdirSync(join(here, "parts"))
  .filter((name) => name.endsWith(".html"))
  .sort();

for (const part of parts) {
  const name = part.replace(/\.html$/, "");
  const body = readFileSync(join(here, "parts", part), "utf8").trim();
  const [markup, ...rest] = body.split("<script data-dc-script");
  const logic = rest.length
    ? `\n<script data-dc-script${rest.join("<script data-dc-script")}`
    : "";
  const page = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
${style}
  </style>
</helmet>
${markup.trim()}
</x-dc>${logic}
</body>
</html>
`;
  writeFileSync(join(here, `${name}.dc.html`), page);
  console.log(`wrote ${name}.dc.html`);
}
