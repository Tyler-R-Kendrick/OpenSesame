/** Actual shipped worker and Cache Storage: callbacks never become the shell. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  trackControlledBirth,
  untilBornControlled,
} from "./lib/push-worker-harness.mjs";

const AUTH_PAGES = [
  "linear.html",
  "native-connector.html",
  "native-implicit.html",
  "native-google.html",
  "redirect.html",
];
const SHELL =
  "<!doctype html><title>Worker regression shell</title><main>APP SHELL</main>";
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
};

async function fixture(dist, base) {
  const controls = { missing: false, offline: false, refusedRequests: 0 };
  const server = http.createServer((request, response) => {
    if (controls.offline) {
      // Renderer emulation does not reliably reach the worker's network stack.
      // Refuse the actual socket so its fetch fails rather than receiving 404.
      controls.refusedRequests += 1;
      request.socket.destroy();
      return;
    }
    const pathname = new URL(request.url, "http://localhost").pathname;
    const relative = pathname.startsWith(base)
      ? pathname.slice(base.length)
      : "";
    if (pathname === base || relative === "index.html") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(SHELL);
    }
    const file = path.resolve(dist, relative);
    if (
      !relative ||
      !file.startsWith(`${path.resolve(dist)}${path.sep}`) ||
      (controls.missing && relative.startsWith("auth/")) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      response.writeHead(404, { "content-type": "text/plain" });
      return response.end("AUTH DOCUMENT NOT FOUND");
    }
    response.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    controls,
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
  };
}

async function shellCopies(page, url) {
  return page.evaluate(async (shellUrl) => {
    const copies = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const shell = await cache.match(shellUrl);
      if (shell) copies.push({ name, body: await shell.text() });
    }
    return copies.sort((a, b) => a.name.localeCompare(b.name));
  }, url);
}

async function successfulCallbacks({
  context,
  origin,
  base,
  dist,
  owner,
  before,
}) {
  const checks = [];
  for (const filename of AUTH_PAGES) {
    const page = await context.newPage();
    try {
      const uri = `${origin}${base}auth/${filename}?state=unowned&code=unowned`;
      const response = await page.goto(uri, { waitUntil: "commit" });
      assert.equal(response.status(), 200);
      assert.deepEqual(
        await response.body(),
        fs.readFileSync(path.join(dist, "auth", filename)),
      );
      assert.equal(
        response.headers()["cross-origin-embedder-policy"],
        "require-corp",
      );
      if (filename !== "redirect.html")
        assert.equal(
          response.headers()["cross-origin-opener-policy"],
          "same-origin",
        );
      assert.deepEqual(
        await shellCopies(owner, `${origin}${base}index.html`),
        before,
      );
      checks.push({ filename, success: true });
    } finally {
      await page.close();
    }
  }
  return checks;
}

async function failedCallbacks({
  context,
  origin,
  base,
  owner,
  before,
  controls,
}) {
  const checks = [];
  controls.missing = true;
  for (const filename of AUTH_PAGES) {
    const page = await context.newPage();
    try {
      const response = await page.goto(`${origin}${base}auth/${filename}`, {
        waitUntil: "commit",
      });
      assert.equal(response.status(), 404);
      assert.equal(await response.text(), "AUTH DOCUMENT NOT FOUND");
      checks.push({ filename, missing: true });
    } finally {
      await page.close();
    }
  }
  controls.offline = true;
  await context.setOffline(true);
  for (const filename of AUTH_PAGES) {
    const page = await context.newPage();
    try {
      await assert.rejects(
        page.goto(`${origin}${base}auth/${filename}`, { waitUntil: "commit" }),
        /net::ERR_/,
      );
      checks.push({ filename, offline: true });
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(
    await shellCopies(owner, `${origin}${base}index.html`),
    before,
  );
  return checks;
}

export async function proveCallbackWorkerIsolation({ browser, dist, base }) {
  const site = await fixture(dist, base);
  const context = await browser.newContext({ serviceWorkers: "allow" });
  try {
    await trackControlledBirth(context);
    const owner = await context.newPage();
    await owner.goto(`${site.origin}${base}`);
    await owner.evaluate(async (scope) => {
      await navigator.serviceWorker.register(`${scope}sw.js`, { scope });
      await navigator.serviceWorker.ready;
    }, base);
    await owner.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
    await owner.reload();
    await untilBornControlled(owner);
    const before = await shellCopies(owner, `${site.origin}${base}index.html`);
    assert.equal(before.length, 1);
    assert.equal(before[0].body, SHELL);
    const args = { ...site, context, base, dist, owner, before };
    const success = await successfulCallbacks(args);
    const failures = await failedCallbacks(args);
    const offline = await context.newPage();
    const response = await offline.goto(`${site.origin}${base}vault/items`, {
      waitUntil: "commit",
    });
    assert.equal(response.status(), 200);
    assert.equal(await response.text(), SHELL);
    assert.ok(site.controls.refusedRequests > 0);
    return {
      success,
      failures,
      shellUnchanged: true,
      offlineAppShell: true,
      refusedNetworkRequests: site.controls.refusedRequests,
    };
  } finally {
    await context.close();
    await new Promise((resolve, reject) =>
      site.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
