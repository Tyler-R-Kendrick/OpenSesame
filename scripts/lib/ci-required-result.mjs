import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A skipped job is acceptable only after a successful, explicit classification. */
export function assertSelectedResult({ draft, preflight, selected, result }) {
  if (draft !== "false") throw new Error("draft or missing draft admission");
  if (preflight !== "success") throw new Error(`preflight: ${preflight}`);
  if (!["true", "false"].includes(selected)) {
    throw new Error("missing or invalid area classification");
  }
  if (selected === "true" && result !== "success") {
    throw new Error(`selected suite: ${result}`);
  }
  if (selected === "false" && !["success", "skipped"].includes(result)) {
    throw new Error(`unselected suite: ${result}`);
  }
}

/** Qualification requires every declared dependency, including every matrix leg. */
export function assertCompleteResults(needs) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error("invalid qualification dependencies");
  }
  const entries = Object.entries(needs);
  if (entries.length === 0) throw new Error("no qualification dependencies");
  for (const [name, value] of entries) {
    if (value?.result !== "success") {
      throw new Error(`${name}: ${value?.result ?? "missing"}`);
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[2] === "all") {
      assertCompleteResults(JSON.parse(process.env.NEEDS_JSON ?? "null"));
    } else {
      assertSelectedResult({
        draft: process.env.DRAFT,
        preflight: process.env.PREFLIGHT_RESULT,
        selected: process.env.SELECTED,
        result: process.env.SUITE_RESULT,
      });
    }
  } catch (error) {
    console.error(`CI required result: ${error.message}`);
    process.exitCode = 1;
  }
}
