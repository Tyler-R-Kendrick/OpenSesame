#!/usr/bin/env node
/** Map only byte-identical staged Go overlays; retain every result and upstream path. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const overlayRoot = "tools/pwa-tailscale-native-http";
const stageRoot = ".codeql-native/source";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function ownedBytes(root, relative) {
  const path = join(root, relative);
  const actual = realpathSync(path);
  const info = lstatSync(path);
  if (actual !== path || !info.isFile() || info.size > 16 * 1024 * 1024)
    throw new Error(`Source path is not a regular owned file: ${relative}`);
  return readFileSync(path);
}

function committedBytes(root, sha, path) {
  return execFileSync(
    "git",
    ["--no-replace-objects", "-C", root, "show", `${sha}:${path}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function assertCheckout(workspace, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected exact source SHA");
  const root = realpathSync(workspace);
  const actualSha = execFileSync(
    "git",
    ["--no-replace-objects", "-C", root, "rev-parse", "HEAD^{commit}"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv,
    },
  ).trim();
  if (actualSha !== sha) throw new Error("Checkout differs from source SHA");
  return root;
}

const groups = [
  ["nativeHttp", () => "cmd/tsconnect/nativehttp"],
  ["nativeBridge", () => "cmd/tsconnect/nativehttp"],
  [
    "nativeNode",
    (name) =>
      name.startsWith("native-extra-dns")
        ? "ipn/ipnlocal"
        : "cmd/tsconnect/wasm",
  ],
  ["publicTrust", () => "cmd/tsconnect/nativehttp"],
  [
    "peerGET",
    (name) =>
      name.startsWith("nodepeerget")
        ? "cmd/tsconnect/wasm"
        : "cmd/tsconnect/nativehttp",
  ],
];

function assertKnownGroups(pins) {
  const known = new Set(groups.map(([group]) => group));
  for (const [group, section] of Object.entries(pins)) {
    if (
      !known.has(group) &&
      Array.isArray(section?.files) &&
      section.files.some(
        (file) => typeof file?.path === "string" && file.path.endsWith(".go"),
      )
    )
      throw new Error(`Unrecognized Go overlay group ${group}`);
  }
}

function addOverlay(root, sha, file, directory, destinations) {
  if (typeof file?.path !== "string") throw new Error("Malformed overlay path");
  if (!file.path.endsWith(".go")) return;
  if (
    !/^[A-Za-z0-9_-]+\.go$/.test(file.path) ||
    !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")
  )
    throw new Error("Malformed Go overlay pin");
  const tracked = `${overlayRoot}/${file.path}`;
  const staged = `${stageRoot}/${directory(file.path)}/${file.path}`;
  const original = committedBytes(root, sha, tracked);
  if (
    hash(original) !== file.sha256 ||
    !original.equals(ownedBytes(root, tracked)) ||
    !original.equals(ownedBytes(root, staged))
  )
    throw new Error(
      `Staged Go overlay differs from committed source: ${file.path}`,
    );
  if (destinations.has(staged))
    throw new Error(`Duplicate staged overlay: ${staged}`);
  destinations.set(staged, tracked);
}

/** Derive only the fixed copied overlay destinations from the verified source plan. */
export function overlayMap(workspace, sha) {
  const root = assertCheckout(workspace, sha);
  const metadata = committedBytes(root, sha, `${overlayRoot}/source.json`);
  if (!metadata.equals(ownedBytes(root, `${overlayRoot}/source.json`)))
    throw new Error("Source plan differs from committed bytes");
  const pins = JSON.parse(metadata.toString("utf8"));
  const destinations = new Map();
  assertKnownGroups(pins);
  for (const [group, directory] of groups) {
    const files = pins[group]?.files;
    if (!Array.isArray(files))
      throw new Error(`Missing fixed overlay group ${group}`);
    for (const file of files)
      addOverlay(root, sha, file, directory, destinations);
  }
  if (!destinations.size)
    throw new Error("No staged Go overlays were verified");
  return destinations;
}

/** The development oracle copies one tracked file into its pinned upstream module. */
export function oracleMap(workspace, sha) {
  const root = assertCheckout(workspace, sha);
  const tracked = "packages/app-core/scripts/sops-oracle/treedump.go";
  const staged = ".codeql-sops/sops-src/treedump/main.go";
  const original = committedBytes(root, sha, tracked);
  if (
    !original.equals(ownedBytes(root, tracked)) ||
    !original.equals(ownedBytes(root, staged))
  )
    throw new Error("Staged oracle differs from committed source");
  return new Map([[staged, tracked]]);
}

function assertIndexedReference(location, artifacts) {
  if (
    !Number.isSafeInteger(location.index) ||
    location.index < 0 ||
    location.index >= artifacts.length
  )
    throw new Error("Invalid SARIF artifact index");
  const referenced = artifacts[location.index]?.location;
  if (!referenced || typeof referenced.uri !== "string")
    throw new Error("Missing indexed SARIF artifact");
  if (
    (location.uri !== undefined && location.uri !== referenced.uri) ||
    (location.uriBaseId !== undefined &&
      location.uriBaseId !== referenced.uriBaseId)
  )
    throw new Error("SARIF artifact reference disagrees with its index");
}

function assertReference(location, artifacts) {
  if (!location || typeof location !== "object" || Array.isArray(location))
    throw new Error("Invalid SARIF artifact location");
  if (location.index !== undefined) {
    assertIndexedReference(location, artifacts);
  } else if (typeof location.uri !== "string") {
    throw new Error("SARIF artifact location has no URI or index");
  }
}

function countInvocations(run, summary) {
  if (!Array.isArray(run.invocations) || !run.invocations.length) {
    summary.invalidInvocations++;
    return;
  }
  for (const invocation of run.invocations) {
    if (invocation.executionSuccessful !== true) summary.invalidInvocations++;
    for (const field of [
      "toolExecutionNotifications",
      "toolConfigurationNotifications",
    ]) {
      if (invocation[field] !== undefined && !Array.isArray(invocation[field]))
        throw new Error("Invalid SARIF notifications");
      summary.errorNotifications += (invocation[field] ?? []).filter(
        (notice) => notice.level === "error",
      ).length;
    }
  }
}

function collectArtifacts(run, mappings, locations) {
  const artifactUris = new Set();
  for (const [index, artifact] of run.artifacts.entries()) {
    const location = artifact.location;
    assertReference(location, run.artifacts);
    if (location.index !== undefined && location.index !== index)
      throw new Error("SARIF artifact has an inconsistent self index");
    locations.push(location);
    const original = location?.uri;
    if (typeof original !== "string") continue;
    const final = mappings.get(original) ?? original;
    const key = `${location.uriBaseId ?? ""}\0${final}`;
    if (artifactUris.has(key))
      throw new Error("Duplicate mapped SARIF artifact");
    artifactUris.add(key);
  }
}

function visitReferences(root, visit) {
  const pending = [root];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "artifactLocation" || key === "analysisTarget") &&
        child !== undefined
      )
        visit(child);
      pending.push(child);
    }
  }
}

function countResults(run, mappings, summary) {
  for (const result of run.results) {
    summary.findings++;
    const location = result.locations?.[0]?.physicalLocation?.artifactLocation;
    const uri = location?.uri ?? run.artifacts[location?.index]?.location?.uri;
    if (typeof uri !== "string" || !mappings.has(uri))
      summary.unmappedPrimaryFindings++;
    visitReferences(result, (child) => {
      const referenced = child.uri ?? run.artifacts[child.index]?.location?.uri;
      if (typeof referenced !== "string" || !mappings.has(referenced))
        summary.unmappedResultLocations++;
    });
  }
}

function inspectRun(run, mappings, locations, summary) {
  if (!Array.isArray(run.results) || !Array.isArray(run.artifacts))
    throw new Error("Missing SARIF results or artifacts");
  countInvocations(run, summary);
  collectArtifacts(run, mappings, locations);
  visitReferences(run, (location) => {
    assertReference(location, run.artifacts);
    locations.push(location);
  });
  countResults(run, mappings, summary);
}

function rewriteLocations(locations, mappings) {
  let count = 0;
  for (const location of new Set(locations)) {
    if (typeof location.uri !== "string" || !mappings.has(location.uri))
      continue;
    if (location.uriBaseId !== "%SRCROOT%")
      throw new Error("Unexpected staged URI base");
    location.uri = mappings.get(location.uri);
    count++;
  }
  return count;
}

/** Mutates a parsed report only after checking duplicate artifact destinations. */
export function mapReport(report, mappings) {
  if (
    report?.version !== "2.1.0" ||
    !Array.isArray(report.runs) ||
    !report.runs.length
  )
    throw new Error("Invalid SARIF runs");
  const summary = {
    findings: 0,
    unmappedPrimaryFindings: 0,
    unmappedResultLocations: 0,
    invalidInvocations: 0,
    errorNotifications: 0,
    reviewedFalsePositives: 0,
  };
  const locations = [];
  for (const run of report.runs) inspectRun(run, mappings, locations, summary);
  return {
    ...summary,
    verifiedFiles: mappings.size,
    mappedLocations: rewriteLocations(locations, mappings),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (
    process.argv.length !== 8 ||
    !["native", "oracle"].includes(process.argv[2])
  )
    throw new Error(
      "Usage: map-composed-go-sarif.mjs native|oracle WORKSPACE SOURCE_SHA INPUT OUTPUT SUMMARY",
    );
  const mappings =
    process.argv[2] === "native"
      ? overlayMap(process.argv[3], process.argv[4])
      : oracleMap(process.argv[3], process.argv[4]);
  const report = JSON.parse(readFileSync(process.argv[5], "utf8"));
  const summary = mapReport(report, mappings);
  writeFileSync(process.argv[6], `${JSON.stringify(report)}\n`, { flag: "wx" });
  writeFileSync(process.argv[7], `${JSON.stringify(summary)}\n`, {
    flag: "wx",
  });
  console.log(
    `Verified ${summary.verifiedFiles} copied files and mapped ${summary.mappedLocations} SARIF locations; retained ${summary.findings} findings, ${summary.unmappedPrimaryFindings} without a verified copied-file primary mapping and ${summary.unmappedResultLocations} result locations without such a mapping. Unsuccessful or missing invocations: ${summary.invalidInvocations}; error-level notifications: ${summary.errorNotifications}.`,
  );
}
