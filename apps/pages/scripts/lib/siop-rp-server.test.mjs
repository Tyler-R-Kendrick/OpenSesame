import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { serveDist } from "./siop-rp-server.mjs";

// The dist server answers exactly two basenames confined under `dist/`;
// traversal (raw or encoded) and every other name are a 404 that never
// reaches the filesystem outside the root.

let dist;
let served;

beforeAll(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "siop-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<title>app</title>");
  fs.writeFileSync(path.join(dist, "siop-metadata.json"), "{}");
  fs.writeFileSync(path.join(dist, "secret.txt"), "not served");
  served = await serveDist(dist);
});

afterAll(async () => {
  await served.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

describe("serveDist", () => {
  test("serves the two allowlisted files", async () => {
    const index = await fetch(`${served.url}/index.html`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /app/);
    const meta = await fetch(`${served.url}/siop-metadata.json`);
    assert.equal(meta.status, 200);
  });

  test("refuses other names and traversal, raw or encoded", async () => {
    for (const name of [
      "secret.txt",
      "../secret.txt",
      "..%2f..%2fetc%2fpasswd",
      "%2e%2e%2findex.html",
      "sub/index.html",
      "index.html%00.png",
    ]) {
      const res = await fetch(`${served.url}/${name}`);
      assert.equal(res.status, 404, name);
    }
  });
});
