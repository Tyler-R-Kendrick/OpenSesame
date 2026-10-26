#!/usr/bin/env node
// Compare every served file with the unchanged extracted candidate. .nojekyll
// is a Pages packaging control file, not a public content endpoint.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function files(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory())
      result.push(...(await files(join(path, entry.name))));
    else if (entry.isFile()) result.push(join(path, entry.name));
    else throw new Error("Unexpected non-file in extracted Pages candidate");
  }
  return result;
}
export async function verifySite(
  directory,
  address,
  source,
  fetcher = fetch,
  deadline = AbortSignal.timeout(120_000),
) {
  if (
    !directory ||
    typeof address !== "string" ||
    !/^[0-9a-f]{40}$/.test(source ?? "")
  )
    throw new Error("Invalid Pages verification inputs");
  const base = new URL(address.endsWith("/") ? address : `${address}/`);
  if (base.href !== "https://tyler-r-kendrick.github.io/OpenSesame/")
    throw new Error("Unexpected production Pages destination");
  const queue = (await files(directory)).filter(
    (path) => relative(directory, path) !== ".nojekyll",
  );
  const attempt = new AbortController();
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      attempt.signal.throwIfAborted();
      deadline.throwIfAborted();
      const path = queue.pop();
      const name = relative(directory, path)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const url = new URL(name, base);
      url.searchParams.set("candidate", source);
      const response = await fetcher(url, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([
          attempt.signal,
          deadline,
          AbortSignal.timeout(15_000),
        ]),
      });
      if (!response.ok)
        throw new Error(
          `Published candidate file ${name}: HTTP ${response.status}`,
        );
      if (
        digest(Buffer.from(await response.arrayBuffer())) !==
        digest(await readFile(path))
      )
        throw new Error(`Published candidate digest differs: ${name}`);
    }
  });
  try {
    await Promise.all(workers);
  } catch (error) {
    attempt.abort();
    await Promise.allSettled(workers);
    throw error;
  }
}

export async function verifySiteEventually(
  directory,
  address,
  source,
  { fetcher = fetch, wait = setTimeout } = {},
) {
  // A fixed budget lets the newly deployed CDN settle without accepting a
  // different candidate, and never turns a permanent mismatch into success.
  const end = Date.now() + 180_000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await verifySite(
        directory,
        address,
        source,
        fetcher,
        AbortSignal.timeout(Math.max(1, Math.min(45_000, end - Date.now()))),
      );
      return;
    } catch (error) {
      if (attempt === 6 || Date.now() + 5_000 >= end) throw error;
      await wait(5_000);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [directory, address, source] = process.argv.slice(2);
  await verifySiteEventually(directory, address, source);
}
