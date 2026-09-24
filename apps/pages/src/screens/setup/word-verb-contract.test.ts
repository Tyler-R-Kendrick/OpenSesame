import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The word-verb rule, watched failing on the shapes that got through it.
 *
 * The first version read `<button\b([^>]*)>`, so the `>` of `() =>` ended the
 * tag and the face was never read; it read only JSX text, so `{busy ?
 * "Syncing…" : "Sync connectors"}` passed; and it knew fourteen verbs, so
 * "Rename" and "Review request" passed. Each case below is one of those.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..", "..", "..");
const lint = join(root, "scripts", "quality", "design-lint.mjs");

/** What one lint run said: its exit code and everything it printed. */
type LintRun = { code: number; output: string };

function lintOne(contents: string): LintRun {
  const dir = mkdtempSync(join(tmpdir(), "design-lint-verbs-"));
  const file = join(dir, "apps/pages/src/sections/access/Broken.tsx");
  execFileSync("mkdir", ["-p", dirname(file)]);
  writeFileSync(file, contents);
  try {
    const output = execFileSync(process.execPath, [lint, "--root", dir, file], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    return { code: 0, output };
  } catch (error) {
    const failure: { status?: number; stdout?: string; stderr?: string } =
      Object(error);
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("word-verb buttons fail design lint", () => {
  it.each([
    [
      "an arrow function in onClick",
      `<button type="button" className="btn btn--sm" onClick={(event) => select(event)}>Review request</button>`,
    ],
    [
      "a verb in a string literal",
      `<button type="button" className="btn">{busy ? "Syncing…" : "Sync connectors"}</button>`,
    ],
    ["a verb the old list missed", `<button type="button">Rename</button>`],
  ])("rejects %s", (_, source) => {
    const result = lintOne(`${source}\n`);
    expect(result.code).toBe(1);
    expect(result.output).toContain("word-verb-button");
  });

  it.each([
    [
      "an icon key",
      `<button type="button" className="icon-btn" aria-label="Rename" title="Rename" onClick={() => rename()}><IconEdit /></button>`,
    ],
    [
      "a pressed toggle",
      `<button type="button" aria-pressed={on} onClick={() => set(true)}>Generate</button>`,
    ],
    [
      "a named choice",
      `<button type="button" className="btn btn--block choice" onClick={() => send()}>Email me a sign-in link</button>`,
    ],
  ])("accepts %s", (_, source) => {
    const result = lintOne(`${source}\n`);
    expect(result.output).not.toContain("word-verb-button");
  });
});
