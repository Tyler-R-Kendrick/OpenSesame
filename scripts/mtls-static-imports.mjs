#!/usr/bin/env node
/**
 * AT-STATIC-IMPORTS — the production browser bundle carries no native
 * transport, filesystem, SPIFFE socket, Host sealing or process adapter code.
 *
 * Two independent checks, both fail-closed:
 *
 *  1. Bundle scan. Builds apps/pages (VITE_BASE=/OpenSesame/) and greps every
 *     dist/**\/*.js for forbidden tokens. An actual embedded PEM private key
 *     body fails; the bare "PRIVATE KEY" marker is legitimate in Pages (it
 *     parses PEM the user pastes) and is only reported.
 *  2. Import graph. The browser packages (apps/pages, packages/os-domain,
 *     packages/contracts, packages/capability-registry) may not depend —
 *     transitively, through runtime `dependencies` — on
 *     @opensesame/control-plane, nor import @opensesame/ingress-evidence's node
 *     entry, nor import node:tls / node:fs / node:net / child_process in their
 *     shipped sources.
 *
 * Usage: node scripts/mtls-static-imports.mjs [--no-build]
 * Prints `MTLS_TESTS passed=<n> failed=<n>` for the manifest runner.
 */
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { typescriptComponents } from "./lib/workspace-graph.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "apps/pages/dist");
const noBuild = process.argv.includes("--no-build");

const BROWSER_PACKAGES = [
  "@opensesame/pages",
  "@opensesame/app-core",
  "@opensesame/vault-core",
  "@opensesame/os-domain",
  "@opensesame/contracts",
  "@opensesame/capability-registry",
];
const FORBIDDEN_PACKAGES = ["@opensesame/control-plane"];

/** [label, regex, hard-fail?] applied to every shipped JS chunk. */
const BUNDLE_TOKENS = [
  ["node:tls", /["'`]node:tls["'`]/, true],
  ["node:fs", /["'`]node:fs(?:\/promises)?["'`]/, true],
  ["node:net", /["'`]node:net["'`]/, true],
  ["child_process", /child_process/, true],
  ["/run/spire", /\/run\/spire/, true],
  [
    "OPENSESAME_SPIFFE_ENDPOINT_SOCKET",
    /OPENSESAME_SPIFFE_ENDPOINT_SOCKET/,
    true,
  ],
  [
    "embedded PEM private key",
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{40,}-----END/,
    true,
  ],
  ["AttestedPeer", /AttestedPeer/, true],
  ["into_verified", /into_verified/, true],
  ["tls.createServer", /tls\.createServer/, true],
  ["unix socket URL", /unix:\/\/\//, true],
  [
    "PEM key marker (informational; legitimate PEM parsing in Pages)",
    /PRIVATE KEY/,
    false,
  ],
  ["spiffe:// literal (informational)", /spiffe:\/\//, false],
];
const SOURCE_IMPORTS =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](node:tls|node:fs(?:\/promises)?|node:net|node:child_process|child_process|tls|net|fs)["']/g;

let passed = 0;
let failed = 0;
const failures = [];
function check(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(`${label}: ${detail}`);
    console.log(`  FAIL ${label}: ${detail}`);
  }
}

function build() {
  if (noBuild && existsSync(distDir)) {
    console.log("==> using existing apps/pages/dist (--no-build)");
    return;
  }
  console.log("==> building apps/pages with VITE_BASE=/OpenSesame/");
  try {
    execFileSync(
      "pnpm",
      ["exec", "turbo", "run", "build", "--filter=@opensesame/pages"],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          VITE_BASE: "/OpenSesame/",
          NODE_OPTIONS: "--max-old-space-size=8192",
        },
      },
    );
    check(true, "apps/pages builds", "");
  } catch (err) {
    check(
      false,
      "apps/pages builds",
      `turbo build exited ${err.status ?? "?"} — nothing to scan`,
    );
    console.log(`MTLS_TESTS passed=${passed} failed=${failed}`);
    process.exit(1);
  }
}

function scanBundle() {
  const files = globSync("**/*.{js,mjs}", { cwd: distDir }).sort();
  check(
    files.length > 0,
    "dist has JS chunks",
    `no *.js under ${relative(root, distDir)}`,
  );
  const hits = new Map();
  for (const f of files) {
    const text = readFileSync(join(distDir, f), "utf8");
    for (const [label, re] of BUNDLE_TOKENS) {
      if (re.test(text))
        (hits.get(label) ?? hits.set(label, []).get(label)).push(f);
    }
  }
  for (const [label, , hard] of BUNDLE_TOKENS) {
    const where = hits.get(label) ?? [];
    if (hard)
      check(where.length === 0, `bundle has no "${label}"`, where.join(", "));
    else
      console.log(
        `  info ${label}: ${where.length} chunk(s)${where.length ? ` — ${where.join(", ")}` : ""}`,
      );
  }
  console.log(`  scanned ${files.length} chunk(s)`);
}

function transitiveDeps(components, name, seen = new Set()) {
  const c = components.find((x) => x.name === name);
  if (!c) return seen;
  for (const d of c.deps) {
    if (!seen.has(d)) {
      seen.add(d);
      transitiveDeps(components, d, seen);
    }
  }
  return seen;
}

/**
 * A browser package's sources, without tests and without a Node-host
 * platform subpath (`src/node/**`, ADR 0133): that is the CLI's host, which
 * `pnpm quality:app-core` keeps as the only place `node:*` may appear and
 * which no browser entry reaches — the bundle scan above checks the chunks
 * a browser actually loads.
 */
function shippedSources(dir) {
  return globSync("src/**/*.{ts,tsx,js,mjs}", { cwd: join(root, dir) })
    .filter(
      (f) =>
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f) &&
        !/__tests__|\/test\//.test(f) &&
        !/^src\/node\//.test(f),
    )
    .sort();
}

function scanGraph() {
  const components = typescriptComponents(root);
  const ingress = components.find(
    (x) => x.name === "@opensesame/ingress-evidence",
  );
  const ingressNodeEntries = ingress
    ? Object.keys(
        JSON.parse(
          readFileSync(join(root, ingress.dir, "package.json"), "utf8"),
        ).exports ?? {},
      ).filter((k) => /node/i.test(k))
    : [];
  if (ingress)
    console.log(
      `  info @opensesame/ingress-evidence node entries: ${ingressNodeEntries.join(", ") || "(none)"}`,
    );
  else
    console.log(
      "  info packages/ingress-evidence not present yet — its node-entry check is vacuous",
    );

  for (const name of BROWSER_PACKAGES) {
    const c = components.find((x) => x.name === name);
    check(Boolean(c), `${name} is a workspace package`, "not found");
    if (!c) continue;
    const deps = transitiveDeps(components, name);
    for (const bad of FORBIDDEN_PACKAGES) {
      check(
        !deps.has(bad),
        `${name} does not depend on ${bad}`,
        "reachable through runtime dependencies",
      );
    }
    const sources = shippedSources(c.dir);
    const nativeImports = [];
    const ingressNode = [];
    for (const f of sources) {
      const text = readFileSync(join(root, c.dir, f), "utf8");
      for (const m of text.matchAll(SOURCE_IMPORTS))
        nativeImports.push(`${f}: ${m[1]}`);
      for (const entry of ingressNodeEntries) {
        const spec = `@opensesame/ingress-evidence${entry.slice(1)}`;
        if (text.includes(`"${spec}"`) || text.includes(`'${spec}'`))
          ingressNode.push(`${f}: ${spec}`);
      }
      if (/@opensesame\/ingress-evidence\/(?:src\/)?node/.test(text))
        ingressNode.push(`${f}: deep node import`);
    }
    check(
      nativeImports.length === 0,
      `${name} shipped sources import no native modules`,
      nativeImports.join("; "),
    );
    check(
      ingressNode.length === 0,
      `${name} does not import ingress-evidence's node entry`,
      ingressNode.join("; "),
    );
  }
}

console.log("==> AT-STATIC-IMPORTS: bundle scan");
build();
scanBundle();
console.log("==> AT-STATIC-IMPORTS: import graph");
scanGraph();
console.log(`MTLS_TESTS passed=${passed} failed=${failed}`);
if (failed > 0) {
  console.error(
    `mtls-static-imports: ${failed} check(s) failed\n  ${failures.join("\n  ")}`,
  );
  process.exit(1);
}
