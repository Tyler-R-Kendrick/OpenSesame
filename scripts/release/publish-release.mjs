#!/usr/bin/env node
// Entry point called only after candidate verify-promotion succeeds in a
// trusted workflow checkout. Every API write rechecks main/version/tag state.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyPromotionProvenance } from "./provenance.mjs";
import { ReleaseApi, prepareDraft, publishDraft } from "./publish-assets.mjs";
import { hash } from "./stage-release.mjs";

const [command, directory] = process.argv.slice(2);
if (!["prepare", "publish"].includes(command) || !directory)
  throw new Error("usage: publish-release.mjs prepare|publish DIRECTORY");
if (process.env.GITHUB_REF !== "refs/heads/main")
  throw new Error("Publication requires the trusted main workflow");
const data = readFileSync(join(directory, "candidate.json"));
const manifest = JSON.parse(data);
if (
  hash(data) !== process.env.PAYLOAD_DIGEST ||
  manifest.candidate_id !== process.env.CANDIDATE_ID ||
  manifest.source_sha !== process.env.SOURCE_SHA
) {
  throw new Error("Publisher candidate identity mismatch");
}
verifyPromotionProvenance({
  directory,
  repository: process.env.GITHUB_REPOSITORY,
  workflowSha: process.env.GITHUB_WORKFLOW_SHA,
  token: process.env.GH_TOKEN,
});
const api = new ReleaseApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
const release = await (command === "prepare" ? prepareDraft : publishDraft)(
  api,
  directory,
  manifest,
  hash(data),
);
if (command === "prepare") {
  const url = new URL(release.html_url);
  if (
    url.origin !== "https://github.com" ||
    !url.pathname.startsWith(`/${process.env.GITHUB_REPOSITORY}/releases/`) ||
    url.username ||
    url.password
  )
    throw new Error("Prepared draft returned an unexpected review URL");
  appendFileSync(process.env.GITHUB_OUTPUT, `draft_url=${url.href}\n`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "## Staged release awaiting publication approval",
      "",
      `Draft notes and assets: ${url.href}`,
      "",
      `- Version: ${manifest.version}`,
      `- Source: ${manifest.source_sha}`,
      `- Candidate: ${manifest.candidate_id}`,
      `- Candidate manifest SHA256: ${hash(data)}`,
      "",
      "The draft and version tag are staged. Pages and native publication both wait for the release environment gate.",
      "",
    ].join("\n"),
  );
}
