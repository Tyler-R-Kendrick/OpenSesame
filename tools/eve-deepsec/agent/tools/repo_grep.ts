import { spawnSync } from "node:child_process";
import { relative } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertRepoFile, repoRoot } from "../lib/paths";

export default defineTool({
  description:
    "Search OpenSesame repo contents with ripgrep. Path is a repo-relative glob or directory.",
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    maxMatches: z.number().int().min(1).max(80).optional(),
  }),
  execute({ pattern, path, glob, maxMatches }) {
    const searchPath = path
      ? relative(repoRoot, assertRepoFile(path)) || "."
      : ".";
    const args = [
      "-n",
      "--no-heading",
      "-m",
      String(maxMatches ?? 40),
      "--",
      pattern,
    ];
    if (glob) args.unshift("--glob", glob);
    args.push(searchPath);
    const result = spawnSync("rg", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 200_000,
    });
    if (result.error) {
      return { ok: false, error: result.error.message, stdout: "", stderr: "" };
    }
    return {
      ok: result.status === 0 || result.status === 1,
      code: result.status,
      stdout: (result.stdout ?? "").slice(0, 60_000),
      stderr: (result.stderr ?? "").slice(0, 8_000),
    };
  },
});
