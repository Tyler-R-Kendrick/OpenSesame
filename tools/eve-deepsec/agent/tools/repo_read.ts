import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertRepoFile, repoRoot } from "../lib/paths";

const MAX_BYTES = 120_000;

export default defineTool({
  description:
    "Read a file from the OpenSesame repository (path relative to repo root). Use this instead of sandbox read_file.",
  inputSchema: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(400).optional(),
  }),
  execute({ path, offset, limit }) {
    const abs = assertRepoFile(path);
    const size = statSync(abs).size;
    if (size > MAX_BYTES) {
      return {
        path: relative(repoRoot, abs),
        error: `file too large (${size} bytes); use repo_grep or offset/limit on a smaller slice`,
      };
    }
    const lines = readFileSync(abs, "utf8").split("\n");
    const start = (offset ?? 1) - 1;
    const count = limit ?? Math.min(lines.length - start, 200);
    const slice = lines.slice(start, start + count);
    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(6, " ")}|${line}`)
      .join("\n");
    return {
      path: relative(repoRoot, abs),
      startLine: start + 1,
      endLine: start + slice.length,
      totalLines: lines.length,
      content: numbered,
    };
  },
});
