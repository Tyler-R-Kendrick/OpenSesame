import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const files = ["index.html", "os-runtime-config.json"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assertRevision(revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid release SHA");
}

export function stampRelease(directory, revision) {
  assertRevision(revision);
  const manifest = {
    format: "opensesame-pages-release",
    version: 1,
    revision,
    sha256: Object.fromEntries(
      files.map((file) => [file, digest(readFileSync(join(directory, file)))]),
    ),
  };
  writeFileSync(
    join(directory, "release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function download(url, maxBytes) {
  const response = await fetch(url, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Release probe HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("Release probe response too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function pagesBase(address) {
  const base = new URL(address);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Release probe requires a clean HTTPS Pages URL");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}

export async function verifyRelease(address, revision) {
  assertRevision(revision);
  const base = pagesBase(address);
  const urlFor = (path) => {
    const url = new URL(path, base);
    url.searchParams.set("release", revision);
    return url;
  };
  const manifest = JSON.parse(await download(urlFor("release.json"), 4096));
  if (
    manifest?.format !== "opensesame-pages-release" ||
    manifest.version !== 1 ||
    manifest.revision !== revision
  )
    throw new Error("Published release does not match the requested commit");
  for (const file of files) {
    const expected = manifest.sha256?.[file];
    if (!/^[a-f0-9]{64}$/.test(expected ?? ""))
      throw new Error(`Release manifest is missing the ${file} digest`);
    if (digest(await download(urlFor(file), 2 * 1024 * 1024)) !== expected)
      throw new Error(`Published ${file} does not match the release digest`);
  }
}
