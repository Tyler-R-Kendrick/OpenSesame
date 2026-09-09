import { execFileSync } from "node:child_process";
import { assertPrSignatures } from "./lib/pr-signatures.mjs";

const [repository, number, head] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !/^[1-9]\d*$/.test(number ?? "") ||
  !/^[a-f0-9]{40}$/.test(head ?? "")
) {
  throw new Error(
    "Usage: check-pr-signatures.mjs OWNER/REPO PR_NUMBER HEAD_SHA",
  );
}
const endpoint = `repos/${repository}/pulls/${number}`;
function api(path, paginate = false) {
  return JSON.parse(
    execFileSync(
      "gh",
      ["api", path, ...(paginate ? ["--paginate", "--slurp"] : [])],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}
const commits = api(`${endpoint}/commits?per_page=100`, true).flat();
assertPrSignatures(api(endpoint), commits, head);
console.log(`Verified signatures: ${commits.length} commits at ${head}`);
