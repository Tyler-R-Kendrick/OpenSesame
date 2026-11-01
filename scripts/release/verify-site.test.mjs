import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifySite, verifySiteEventually } from "./verify-site.mjs";

function site() {
  const directory = mkdtempSync(join(tmpdir(), "verify-site-test-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "index.html"), "current HTML");
  writeFileSync(join(directory, "release.json"), '{"revision":"current"}');
  writeFileSync(join(directory, "assets/main.js"), "current JavaScript");
  writeFileSync(join(directory, ".nojekyll"), "");
  return directory;
}
const origin = "https://opensesame-labs.github.io/OpenSesame/";
const source = "a".repeat(40);

test("live verification checks nested application bytes and ignores only the hosting control file", async () => {
  const directory = site();
  const seen = [];
  try {
    await verifySite(directory, origin, source, async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      assert.equal(url.searchParams.get("candidate"), source);
      const name = url.pathname.slice("/OpenSesame/".length);
      seen.push(name);
      return new Response(readFileSync(join(directory, name)));
    });
    assert.deepEqual(seen.sort(), [
      "assets/main.js",
      "index.html",
      "release.json",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("current HTML and marker cannot hide stale or missing JavaScript", async () => {
  const directory = site();
  try {
    for (const status of [200, 404])
      await assert.rejects(
        verifySite(directory, origin, source, async (url) => {
          const name = url.pathname.slice("/OpenSesame/".length);
          return name === "assets/main.js"
            ? new Response("stale", { status })
            : new Response(readFileSync(join(directory, name)));
        }),
        /assets\/main.js/,
      );
    await assert.rejects(
      verifySite(directory, "https://other.example/", source),
      /destination/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new deployment retries a stale CDN within a fixed budget and still rejects permanent drift", async () => {
  const directory = site();
  let retries = 0;
  try {
    const serve = async (url) =>
      retries === 0
        ? new Response("not propagated", { status: 404 })
        : new Response(
            readFileSync(
              join(directory, url.pathname.slice("/OpenSesame/".length)),
            ),
          );
    await verifySiteEventually(directory, origin, source, {
      fetcher: serve,
      wait: async (delay) => {
        assert.equal(delay, 5000);
        retries++;
      },
    });
    assert.equal(retries, 1);
    retries = 0;
    await assert.rejects(
      verifySiteEventually(directory, origin, source, {
        fetcher: async () => new Response("wrong"),
        wait: async () => {
          retries++;
        },
      }),
      /differs/,
    );
    assert.equal(retries, 5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
