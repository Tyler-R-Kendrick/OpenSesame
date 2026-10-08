import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function identity(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function durableWrite(directory, name, write) {
  const temporary = join(directory, `.${name}.${randomUUID()}.partial`);
  const target = join(directory, name);
  // A run owns a fresh directory. Never replace an earlier receipt silently.
  try {
    await stat(target);
    throw new Error("Coverage receipt already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Leave a failed partial write for diagnosis; only the completed receipt
  // admits these artifacts, and the caller propagates every write failure.
  await write(temporary);
  const file = await open(temporary, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const recorded = await identity(temporary);
  await rename(temporary, target);
  await syncDirectory(directory);
  return { file: name, ...recorded };
}

async function compressedMap(directory, name, value) {
  async function* chunks() {
    yield "{";
    let first = true;
    for (const [key, entry] of Object.entries(value)) {
      if (!first) yield ",";
      yield `${JSON.stringify(key)}:${JSON.stringify(entry)}`;
      first = false;
    }
    yield "}\n";
  }
  return durableWrite(directory, name, async (temporary) => {
    await pipeline(
      Readable.from(chunks()),
      createGzip({ level: 1 }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
  });
}

export function coverageInventoryDigest(inventory) {
  return createHash("sha256")
    .update(
      JSON.stringify([...inventory].sort(([a], [b]) => a.localeCompare(b))),
    )
    .digest("hex");
}

export async function persistCoverageReceipt(directory, summary, finished) {
  // Only a successfully sealed, completely validated union has aggregate
  // counters. A poisoned append never exposes partial metrics or provenance.
  if (summary.aggregate !== null && finished === undefined)
    throw new Error("Aggregate coverage requires a complete sealed union");
  if (summary.aggregate === null && finished !== undefined)
    throw new Error("Incomplete coverage cannot publish a union");
  if (
    summary.admission === "PASS" &&
    (summary.aggregate === null || finished === undefined)
  )
    throw new Error("Passing coverage requires a complete sealed union");
  if (!["PASS", "FAIL"].includes(summary.admission))
    throw new Error("Invalid coverage admission");
  await mkdir(directory, { recursive: true });
  const claim = await open(
    join(directory, ".coverage-receipt.claim"),
    "wx",
    0o600,
  ).catch((error) => {
    if (error.code === "EEXIST")
      throw new Error("Coverage receipt already exists or is claimed");
    throw error;
  });
  try {
    await claim.writeFile(
      `${JSON.stringify({ v: 1, writer: randomUUID() })}\n`,
    );
    await claim.sync();
  } finally {
    await claim.close();
  }
  await syncDirectory(directory);
  const artifacts = [];
  if (finished !== undefined) {
    artifacts.push(
      await compressedMap(
        directory,
        "coverage-union.json.gz",
        finished.coverage,
      ),
    );
    artifacts.push(
      await compressedMap(
        directory,
        "coverage-provenance.json.gz",
        finished.provenance,
      ),
    );
  }
  const receipt = structuredClone({ ...summary, artifacts });
  const result = await durableWrite(
    directory,
    "coverage-admission.json",
    async (temporary) => {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
      } finally {
        await file.close();
      }
    },
  );
  return { ...result, artifacts };
}
