import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

describe("static AgentAuth example", () => {
  it("contains no confidential secrets", () => {
    const files = walk(root);
    expect(files.some((f) => f.endsWith("auth.md"))).toBe(true);
    for (const file of files) {
      if (!/\.(html|md|json)$/u.test(file) && !file.endsWith("main.ts"))
        continue;
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(
        /sk_live|BEGIN PRIVATE KEY|client_secret\s*[:=]/u,
      );
    }
  });

  it("publishes PRM pointing at the Identity API, not a local backend", () => {
    const prm = JSON.parse(
      readFileSync(
        join(root, "public/.well-known/oauth-protected-resource"),
        "utf8",
      ),
    ) as { authorization_servers: string[] };
    expect(prm.authorization_servers).toEqual(["http://127.0.0.1:8788"]);
  });
});
