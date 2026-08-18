import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { deepsecRoot, repoRoot } from "../lib/paths";

type Candidate = {
  file: string;
  slug: string;
  line?: number;
};

function walkJson(dir: string, acc: string[]): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir, { encoding: "utf8" });
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) walkJson(full, acc);
      else if (name.endsWith(".json")) acc.push(full);
    } catch {
      /* skip unreadable entries */
    }
  }
}

export default defineTool({
  description:
    "List Deepsec pattern-scan candidates. Filter by vuln slug and/or path prefix. Does not call AI process.",
  inputSchema: z.object({
    slug: z.string().min(1).optional(),
    pathPrefix: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  execute({ slug, pathPrefix, limit }) {
    const filesRoot = join(deepsecRoot, "data", "opensesame", "files");
    const jsonFiles: string[] = [];
    walkJson(filesRoot, jsonFiles);
    const bySlug = new Map<string, number>();
    const hits: Candidate[] = [];
    const cap = limit ?? 40;
    for (const jsonPath of jsonFiles) {
      let data: { path?: string; candidates?: Array<{ vulnSlug?: string; line?: number }> };
      try {
        data = JSON.parse(readFileSync(jsonPath, "utf8")) as typeof data;
      } catch {
        continue;
      }
      const rel = typeof data.path === "string" ? data.path : relative(repoRoot, jsonPath);
      if (pathPrefix && !rel.startsWith(pathPrefix)) continue;
      for (const c of data.candidates ?? []) {
        const s = c.vulnSlug;
        if (!s) continue;
        bySlug.set(s, (bySlug.get(s) ?? 0) + 1);
        if (slug && s !== slug) continue;
        if (hits.length < cap) {
          hits.push({ file: rel, slug: s, line: c.line });
        }
      }
    }
    const topSlugs = [...bySlug.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, count]) => ({ slug: name, count }));
    return {
      files: jsonFiles.length,
      totalHits: [...bySlug.values()].reduce((n, c) => n + c, 0),
      topSlugs,
      hits,
    };
  },
});
