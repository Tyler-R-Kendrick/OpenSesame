// Browser client-certificate capability (SW-INTEROP, IOP-BROWSER).
//
//   node apps/pages/scripts/verify-browser-cert.mjs
//   (driven by scripts/mtls-browser-test.mjs, which builds dist/ first)
//
// WHAT A PASS HERE MEANS — read this before quoting the result.
//
// Playwright's `clientCertificates` is a *harness* configuration: the driver
// performs the TLS handshake with a certificate the test provisioned, and the
// page never sees it. It is not an API the PWA has, and it is not how a real
// person's certificate reaches a device. So a green run proves exactly one
// thing: **when a browser context is externally provisioned with a client
// certificate, the supported endpoint admits it, and when it is not, the
// endpoint refuses.** It says nothing about certificate enrollment,
// OS/keychain storage, the platform certificate-selection prompt, smartcards,
// or what any user sees. Those are UNTESTED here and are recorded as such.
//
// Rules this harness keeps, which are the whole point of it:
//   * `ignoreHTTPSErrors` is never set, CSP is never bypassed, and
//     certificate verification is never disabled. The disposable root is
//     trusted only by this process, through `NODE_EXTRA_CA_CERTS` — an
//     isolated, runner-supported trust facility, not a system trust store.
//   * every certificate is minted by the system `openssl` into a temporary
//     directory that is removed at the end; nothing is committed.
//   * the endpoint is the Identity plane's real TLS listener, not a mock.
//   * a scenario that cannot run prints `not_executed` with its blocker and
//     fails the run; nothing here is allowed to be silently skipped.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const DIST = resolve(here, "..", "dist");
const OPERATION = "nats.callout.decide";
const chromiumPath =
  process.env.PLAYWRIGHT_CHROMIUM ?? "/opt/pw-browsers/chromium";

// `NODE_EXTRA_CA_CERTS` must be in place before Node starts, so the first
// invocation mints the PKI and re-executes itself with the variable set. The
// trust is scoped to this one process and dies with it.
if (!process.env.IOP_BROWSER_CA) {
  const dir = mkdtempSync(join(tmpdir(), "opensesame-iop-browser-"));
  const { makePki } = await import(
    resolve(repoRoot, "tests/mtls-interop/harness/browser-cert-endpoint.mjs")
  );
  const pki = makePki(dir);
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=8192",
        NODE_EXTRA_CA_CERTS: pki.root,
        IOP_BROWSER_CA: pki.root,
        IOP_BROWSER_DIR: dir,
      },
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    process.exit(error.status ?? 1);
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const dir = process.env.IOP_BROWSER_DIR;
const { pkiPaths, writeBindings, startIdentityEndpoint } = await import(
  resolve(repoRoot, "tests/mtls-interop/harness/browser-cert-endpoint.mjs")
);
// The parent minted it; re-minting here would replace the root Node already
// loaded through NODE_EXTRA_CA_CERTS.
const pki = pkiPaths(dir);
const bindings = writeBindings(dir, OPERATION);

const results = [];
let failures = 0;
const emit = (record) => {
  results.push(record);
  if (record.result === "failed" || record.result === "not_executed")
    failures += 1;
  console.log(`IOP_BROWSER ${JSON.stringify(record)}`);
};
const check = (id, ok, detail, scenario) =>
  emit({
    id,
    scenario_ids: scenario,
    result: ok ? "passed" : "failed",
    detail,
  });

if (!existsSync(chromiumPath)) {
  emit({
    id: "chromium",
    result: "not_executed",
    detail: `no browser at ${chromiumPath}; a missing browser is red, not skipped`,
  });
  console.log("IOP_BROWSER_SUMMARY not_executed=1");
  process.exit(1);
}

const { chromium } = await import("@playwright/test");

// ---- the supported endpoint ------------------------------------------------
let endpoint;
try {
  endpoint = await startIdentityEndpoint({ repoRoot, pki, bindings, dir });
} catch (error) {
  emit({
    id: "identity-endpoint",
    scenario_ids: ["AT-BROWSER-EXTERNAL"],
    result: "not_executed",
    detail: String(error.message).slice(0, 400),
  });
  console.log("IOP_BROWSER_SUMMARY not_executed=1");
  process.exit(1);
}
const origin = `https://localhost:${endpoint.port}`;
const probe = `${origin}/probe/${OPERATION}`;

// ---- the real static app, served with no certificate at all ----------------
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};
// A document on the app's own origin that carries no script and therefore
// never navigates. The CORS check below needs an origin, not the application:
// driving the real app made the probe race its client-side navigation, which
// destroyed the evaluate's execution context on a loaded runner.
const CORS_PROBE_PATH = "/__cors-probe";
const staticServer = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === CORS_PROBE_PATH) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>cors probe</title>");
  }
  const rel = path.replace(/^\/OpenSesame\//, "").replace(/^\//, "");
  const file = join(DIST, rel);
  const send = (body, type) => {
    res.writeHead(200, { "content-type": type });
    res.end(body);
  };
  try {
    if (rel && existsSync(file) && extname(file))
      return send(
        readFileSync(file),
        MIME[extname(file)] ?? "application/octet-stream",
      );
    return send(readFileSync(join(DIST, "index.html")), "text/html");
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => staticServer.listen(0, "127.0.0.1", r));
const staticOrigin = `http://127.0.0.1:${staticServer.address().port}`;

const browser = await chromium.launch({ executablePath: chromiumPath });
const engine = {
  engine: "chromium",
  version: browser.version(),
  playwright: "1.55.1",
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
};
emit({ id: "coverage", result: "recorded", detail: engine });

try {
  // 1. AT-BROWSER-EXTERNAL — an externally provisioned certificate is
  //    admitted, and the endpoint's authorization still decides.
  const enrolled = await browser.newContext({
    clientCertificates: [
      {
        origin,
        certPath: pki.enrolled.cert,
        keyPath: pki.enrolled.key,
      },
    ],
  });
  const page = await enrolled.newPage();
  const response = await page.goto(probe);
  check(
    "enrolled-certificate-admitted",
    response?.status() === 200,
    `status ${response?.status()}`,
    ["AT-BROWSER-EXTERNAL"],
  );
  const body = await page.textContent("body");
  check(
    "enrolled-binding-resolved",
    (body ?? "").includes("svc:browser"),
    (body ?? "").slice(0, 120),
    ["AT-BROWSER-EXTERNAL"],
  );

  // 1b. The same provisioned context is still refused the operation its
  //     binding does not list: the certificate authenticates, it does not
  //     authorize.
  const forbidden = await page.goto(`${origin}/probe/transport.probe`);
  check(
    "enrolled-certificate-is-not-authorization",
    forbidden?.status() === 403 &&
      forbidden.headers()["x-opensesame-transport-error"] === "peer_disallowed",
    `status ${forbidden?.status()} ${forbidden?.headers()["x-opensesame-transport-error"]}`,
    ["AT-BROWSER-EXTERNAL"],
  );

  // 2. AT-BROWSER-CORS — ambient certificate authentication does not make a
  //    cross-origin read succeed. The page is the real static app's origin,
  //    the context holds the certificate, the endpoint sends no CORS
  //    headers, and the fetch must fail visibly rather than return data.
  const corsContext = await browser.newContext({
    clientCertificates: [
      { origin, certPath: pki.enrolled.cert, keyPath: pki.enrolled.key },
    ],
  });
  const corsPage = await corsContext.newPage();
  // Same origin as the app, served by the same server, but a static document
  // that cannot navigate out from under the evaluate.
  await corsPage.goto(`${staticOrigin}${CORS_PROBE_PATH}`, {
    waitUntil: "domcontentloaded",
  });
  const cors = await corsPage.evaluate(async (url) => {
    try {
      const r = await fetch(url, { credentials: "include", mode: "cors" });
      return {
        ok: true,
        status: r.status,
        text: (await r.text()).slice(0, 80),
      };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 120) };
    }
  }, probe);
  check(
    "cross-origin-read-is-refused-despite-the-certificate",
    cors.ok === false,
    JSON.stringify(cors),
    ["AT-BROWSER-CORS"],
  );
  await corsContext.close();

  // 3. A context provisioned with a *valid but unbound* certificate: the
  //    handshake completes and the endpoint refuses at admission. This is
  //    the distinction the whole suite exists to keep — a 403, not an alert.
  const unenrolled = await browser.newContext({
    clientCertificates: [
      { origin, certPath: pki.unenrolled.cert, keyPath: pki.unenrolled.key },
    ],
  });
  const unenrolledPage = await unenrolled.newPage();
  const denied = await unenrolledPage.goto(probe);
  check(
    "unbound-certificate-completes-tls-and-is-denied",
    denied?.status() === 403 &&
      denied.headers()["x-opensesame-transport-error"] === "peer_not_bound",
    `status ${denied?.status()} ${denied?.headers()["x-opensesame-transport-error"]}`,
    ["AT-BROWSER-EXTERNAL"],
  );
  await unenrolled.close();

  // 4. No certificate for this origin at all. Playwright's TLS stack is
  //    still in the path (a certificate is declared for an unrelated
  //    origin), so the failure is specifically the missing client
  //    certificate — the server's own `certificate required` alert — and
  //    not a server-trust problem.
  const anonymous = await browser.newContext({
    clientCertificates: [
      {
        origin: "https://elsewhere.iop.test",
        certPath: pki.enrolled.cert,
        keyPath: pki.enrolled.key,
      },
    ],
  });
  const anonymousPage = await anonymous.newPage();
  const refused = await anonymousPage
    .goto(probe)
    .catch((error) => ({ status: () => 0, error: String(error) }));
  const refusedText = await anonymousPage.textContent("body").catch(() => "");
  check(
    "no-certificate-is-refused-in-the-handshake",
    refused?.status() !== 200 &&
      /certificate required/i.test(`${refusedText}${refused?.error ?? ""}`),
    `status ${refused?.status()} ${String(refusedText).slice(0, 140)}`,
    ["AT-BROWSER-EXTERNAL"],
  );
  await anonymous.close();
  await enrolled.close();

  // 5. STATIC-CORE — the real built Pages app, no certificate anywhere, no
  //    backend. It must boot and show its first screen.
  if (!existsSync(join(DIST, "index.html"))) {
    emit({
      id: "static-app-without-any-certificate",
      scenario_ids: ["AT-STATIC-EMPTY"],
      result: "not_executed",
      detail: `no build at ${DIST}; run the pages build first`,
    });
  } else {
    const plain = await browser.newContext();
    const plainPage = await plain.newPage();
    const errors = [];
    plainPage.on("pageerror", (error) => errors.push(String(error)));
    plainPage.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await plainPage.goto(`${staticOrigin}/OpenSesame/`, {
      waitUntil: "domcontentloaded",
    });
    await plainPage.waitForTimeout(1500);
    const rendered = await plainPage.evaluate(
      () => (document.body?.innerText ?? "").trim().length,
    );
    check(
      "static-app-without-any-certificate",
      rendered > 0 && errors.length === 0,
      `rendered ${rendered} chars, ${errors.length} errors: ${errors.slice(0, 2).join(" | ").slice(0, 200)}`,
      ["AT-STATIC-EMPTY"],
    );
    await plain.close();
  }
} finally {
  await browser.close();
  endpoint.stop();
  staticServer.close();
}

emit({
  id: "coverage-limits",
  result: "recorded",
  detail:
    "harness-provisioned TLS only. Certificate enrollment, OS/keychain storage, the platform certificate-selection prompt, smartcard/PIV, Firefox, WebKit, Windows, macOS, iOS and Android are NOT tested here and no claim is made about them.",
});

const passed = results.filter((r) => r.result === "passed").length;
console.log(
  `IOP_BROWSER_SUMMARY passed=${passed} failed=${results.filter((r) => r.result === "failed").length} not_executed=${results.filter((r) => r.result === "not_executed").length}`,
);
console.log(`MTLS_TESTS passed=${passed} failed=${failures} not_executed=0`);
process.exit(failures > 0 ? 1 : 0);
