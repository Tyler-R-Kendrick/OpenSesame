#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = path.join(import.meta.dirname, "deepsec-wave2-grok-manifest.mjs");

test("DEEPSEC_GROK_MANIFEST_SORT=candidates orders by candidate count", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-manifest-"));
  const filesRoot = path.join(tmp, ".deepsec", "data", "opensesame", "files");
  fs.mkdirSync(filesRoot, { recursive: true });
  const writeRec = (filePath, candidates) => {
    const safe = filePath.replace(/\//g, "_");
    fs.writeFileSync(
      path.join(filesRoot, `${safe}.json`),
      JSON.stringify({
        filePath,
        candidates: candidates.map((id) => ({ id })),
        analysisHistory: [],
      }),
    );
    fs.writeFileSync(path.join(tmp, filePath), "// stub\n");
    fs.mkdirSync(path.dirname(path.join(tmp, filePath)), { recursive: true });
  };
  writeRec("many.rs", [1, 2, 3]);
  writeRec("few.rs", []);
  writeRec("one.rs", [1]);

  const env = { ...process.env, DEEPSEC_GROK_MANIFEST_SORT: "candidates" };
  const run = spawnSync(
    process.execPath,
    [script, tmp, "2", "all"],
    { encoding: "utf8", env },
  );
  assert.equal(run.status, 0, run.stderr);
  const paths = JSON.parse(run.stdout.trim());
  assert.deepEqual(paths.slice(0, 3), ["few.rs", "one.rs", "many.rs"]);
});

test("wall-twice deferred paths sort after first wall retry", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-manifest-"));
  const filesRoot = path.join(tmp, ".deepsec", "data", "opensesame", "files");
  const deferredPath = path.join(tmp, ".deepsec", "wave2-grok-deferred.json");
  fs.mkdirSync(filesRoot, { recursive: true });
  fs.mkdirSync(path.dirname(deferredPath), { recursive: true });
  fs.writeFileSync(
    deferredPath,
    JSON.stringify({
      entries: [
        {
          filePath: "once.rs",
          reason: "file_wall_exceeded",
          deferredAt: "2026-10-01T00:00:00Z",
          attempts: 1,
        },
        {
          filePath: "twice.rs",
          reason: "file_wall_exceeded",
          deferredAt: "2026-10-02T00:00:00Z",
          attempts: 2,
        },
      ],
    }),
  );
  const writeRec = (filePath) => {
    fs.writeFileSync(
      path.join(filesRoot, `${filePath.replace(/\//g, "_")}.json`),
      JSON.stringify({ filePath, candidates: [], analysisHistory: [] }),
    );
    fs.mkdirSync(path.dirname(path.join(tmp, filePath)), { recursive: true });
    fs.writeFileSync(path.join(tmp, filePath), "// stub\n");
  };
  writeRec("fresh.rs");
  writeRec("once.rs");
  writeRec("twice.rs");

  const env = { ...process.env, DEEPSEC_GROK_MANIFEST_SORT: "path" };
  const run = spawnSync(
    process.execPath,
    [script, tmp, "2", "all"],
    { encoding: "utf8", env },
  );
  assert.equal(run.status, 0, run.stderr);
  const paths = JSON.parse(run.stdout.trim());
  assert.deepEqual(paths, ["fresh.rs", "once.rs", "twice.rs"]);
});
