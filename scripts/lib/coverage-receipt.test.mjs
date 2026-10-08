import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { it } from "vitest";
import {
  coverageInventoryDigest,
  persistCoverageReceipt,
} from "./coverage-receipt.mjs";
import { createExactSiteUnion } from "./coverage-union.mjs";

async function fixtureForReceipt(which = "signed") {
  const directory = await mkdtemp(join(tmpdir(), "coverage-receipt-controls-"));
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/native-coverage-sites.json", import.meta.url),
    ),
  );
  const path = "/coverage-fixture/native.ts";
  const native = {
    [path]: {
      ...(which === "signed"
        ? fixture.signedImplicitElse.file
        : fixture.variants[0].file),
      path,
    },
  };
  const raw = Buffer.from(JSON.stringify(native));
  const rawSha256 = createHash("sha256").update(raw).digest("hex");
  const accumulator = createExactSiteUnion(
    new Map([[path, native[path].sourceSha256]]),
  );
  accumulator.append(
    { [path]: native[path] },
    { contributor: "actual-native-report", rawSha256: rawSha256 },
  );
  const sealed = accumulator.finish();
  const floors = { lines: 95, functions: 94, branches: 88, statements: 94 };
  const summary = {
    qualification:
      "PRIVATE receipt writer control using a single SHA-verified native record; not canonical coverage admission",
    admission: "FAIL",
    stage: "thresholds",
    thresholds: floors,
    packageLinesFloor: 50,
    sourceInventorySha256: coverageInventoryDigest(
      new Map([[path, native[path].sourceSha256]]),
    ),
    // The fixture aggregate is explicitly a writer-shape control, not a measured
    // global value. Actual saved-65 metrics are reported separately by trial.mjs.
    aggregate: {
      lines: [0, 1],
      statements: [0, 1],
      functions: [0, 1],
      branches: [0, 1],
    },
    rawReports: [{ sha256: rawSha256, bytes: raw.length }],
  };
  return { directory, path, native, sealed, floors, summary };
}

it("persists complete FAIL counters, floors and reversible artifacts without replacing receipts", async () => {
  const { directory, sealed, floors, summary } = await fixtureForReceipt();
  const target = join(directory, "completed-fail");
  const result = await persistCoverageReceipt(target, summary, sealed);
  const saved = JSON.parse(await readFile(join(target, result.file)));
  assert.equal(saved.admission, "FAIL");
  assert.deepEqual(saved.thresholds, floors);
  assert.deepEqual(saved.aggregate, summary.aggregate);
  for (const artifact of result.artifacts) {
    const bytes = await readFile(join(target, artifact.file));
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      artifact.sha256,
    );
    assert.equal((await stat(join(target, artifact.file))).mode & 0o777, 0o600);
    const decoded = JSON.parse(gunzipSync(bytes));
    assert.deepEqual(
      decoded,
      artifact.file.includes("provenance")
        ? sealed.provenance
        : sealed.coverage,
    );
  }
  const original = await readFile(join(target, result.file));
  await assert.rejects(
    persistCoverageReceipt(target, summary, sealed),
    /already exists/,
  );
  assert.deepEqual(await readFile(join(target, result.file)), original);
});
it("persists validation failure without partial metrics or invalid admission", async () => {
  const { directory, summary, sealed } = await fixtureForReceipt();
  const incomplete = {
    ...summary,
    stage: "native-validation",
    aggregate: null,
  };
  const rejected = await persistCoverageReceipt(
    join(directory, "rejected"),
    incomplete,
  );
  const rejectionReceipt = JSON.parse(
    await readFile(join(directory, "rejected", rejected.file)),
  );
  assert.equal(rejectionReceipt.aggregate, null);
  assert.deepEqual(rejectionReceipt.artifacts, []);
  await assert.rejects(
    persistCoverageReceipt(join(directory, "invalid-pass"), {
      ...incomplete,
      admission: "PASS",
    }),
    /Passing/,
  );
  await assert.rejects(
    persistCoverageReceipt(join(directory, "unsealed"), summary),
    /complete sealed/,
  );
  await assert.rejects(
    persistCoverageReceipt(join(directory, "partial"), incomplete, sealed),
    /Incomplete/,
  );
});
it("binds inventory digest to source SHA independent of enumeration order", async () => {
  const { path, native, summary } = await fixtureForReceipt();
  const inventory = new Map([
    ["/second.ts", "b".repeat(64)],
    [path, native[path].sourceSha256],
  ]);
  assert.equal(
    coverageInventoryDigest(inventory),
    coverageInventoryDigest(new Map([...inventory].reverse())),
  );
  inventory.set(path, "a".repeat(64));
  assert.notEqual(
    coverageInventoryDigest(inventory),
    summary.sourceInventorySha256,
  );
});

it("allows exactly one concurrent writer and preserves its matching complete artifacts", async () => {
  const first = await fixtureForReceipt();
  const second = await fixtureForReceipt("transport");
  const target = join(first.directory, "concurrent");
  const fixtures = [first, second];
  const attempts = await Promise.allSettled(
    fixtures.map(({ summary, sealed }) =>
      persistCoverageReceipt(target, summary, sealed),
    ),
  );
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((x) => x.status === "rejected").length, 1);
  const winner = attempts.findIndex((x) => x.status === "fulfilled");
  const selected = fixtures[winner];
  assert.ok(selected);
  const receipt = JSON.parse(
    await readFile(join(target, "coverage-admission.json")),
  );
  assert.equal(
    receipt.sourceInventorySha256,
    selected.summary.sourceInventorySha256,
  );
  for (const artifact of receipt.artifacts) {
    const bytes = await readFile(join(target, artifact.file));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      artifact.sha256,
    );
    assert.deepEqual(
      JSON.parse(gunzipSync(bytes)),
      artifact.file.includes("provenance")
        ? selected.sealed.provenance
        : selected.sealed.coverage,
    );
  }
});
it("retains an exclusive claim after partial write failure without publishing admission", async () => {
  const { directory, summary, sealed } = await fixtureForReceipt();
  const target = join(directory, "partial-write");
  await mkdir(target);
  const original = join(target, "coverage-provenance.json.gz");
  await writeFile(original, "existing-proof", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    persistCoverageReceipt(target, summary, sealed),
    /already exists/,
  );
  await assert.rejects(
    readFile(join(target, "coverage-admission.json")),
    (error) => error.code === "ENOENT",
  );
  await assert.rejects(
    persistCoverageReceipt(target, summary, sealed),
    /claimed/,
  );
  assert.equal(await readFile(original, "utf8"), "existing-proof");
});
