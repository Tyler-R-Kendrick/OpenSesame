#!/usr/bin/env node
// Every intermediate is an immutable named artifact with a server-recorded
// upload digest. No wildcard merge can silently overwrite another job's file.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { downloadNamedArtifact } from "./artifact-transfer.mjs";

const {
  CANDIDATE_ID,
  VERSION,
  GITHUB_REPOSITORY,
  GH_TOKEN,
  GITHUB_RUN_ID,
  GITHUB_RUN_ATTEMPT,
} = process.env;
if (
  !/^[0-9a-f]{40}-[1-9][0-9]*-[1-9][0-9]*$/.test(CANDIDATE_ID ?? "") ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(VERSION ?? "")
)
  throw new Error("Invalid build identity");
const tag = `v${VERSION}`;
const records = [
  ["bridge", "production", "opensesame-env-parse.mjs"],
  ["pages", "production", `opensesame-pages_${tag}.tar.gz`],
];
for (const target of [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
]) {
  records.push(
    [`kit-${target}`, "production", `opensesame-kit_${tag}_${target}.tar.gz`],
    [
      `test-proxy-${target}`,
      "test-only",
      `opensesame-surrogate-proxy-TEST-upstream-override_${tag}_${target}.tar.gz`,
    ],
  );
}
for (const [part, role, filename] of records) {
  const destination = join("incoming", part);
  await downloadNamedArtifact({
    repository: GITHUB_REPOSITORY,
    token: GH_TOKEN,
    runId: GITHUB_RUN_ID,
    runAttempt: GITHUB_RUN_ATTEMPT,
    expectedName: `${CANDIDATE_ID}-${part}`,
    destination,
  });
  const files = await readdir(destination);
  if (files.length !== 1 || files[0] !== filename)
    throw new Error(`Unexpected intermediate inventory: ${part}`);
  await mkdir(join("payload", role), { recursive: true });
  await copyFile(join(destination, filename), join("payload", role, filename));
}
