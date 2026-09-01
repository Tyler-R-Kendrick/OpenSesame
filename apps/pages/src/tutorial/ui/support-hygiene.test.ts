import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Comments are stripped before the sweep: this file's own subjects are named
 * in the prose that explains why they are absent, and a rule that could not
 * survive being written down would be a rule nobody could document.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sources(): ReadonlyArray<{ name: string; text: string }> {
  const files = readdirSync(here)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .filter((name) => !name.endsWith(".test.ts") && !name.endsWith(".test.tsx"))
    .map((name) => ({
      name: `ui/${name}`,
      text: readFileSync(join(here, name), "utf8"),
    }));
  return [
    ...files,
    {
      name: "session.ts",
      text: readFileSync(join(here, "..", "session.ts"), "utf8"),
    },
  ];
}

describe("support surface hygiene", () => {
  it("covers the whole surface", () => {
    const names = sources().map((file) => file.name);
    expect(names).toContain("session.ts");
    expect(names).toContain("ui/SupportPanel.tsx");
    expect(names).toContain("ui/SupportLauncher.tsx");
  });

  it("writes model text to the document only as text", () => {
    for (const file of sources()) {
      expect(code(file.text), file.name).not.toContain(
        "dangerouslySetInnerHTML",
      );
      expect(code(file.text), file.name).not.toContain("innerHTML");
      expect(code(file.text), file.name).not.toContain("insertAdjacentHTML");
    }
  });

  it("never persists a support conversation", () => {
    for (const file of sources()) {
      const text = code(file.text);
      expect(text, file.name).not.toContain("localStorage");
      expect(text, file.name).not.toContain("sessionStorage");
      expect(text, file.name).not.toContain("indexedDB");
      expect(text, file.name).not.toContain("IDBFactory");
    }
  });

  it("never logs a support conversation", () => {
    for (const file of sources()) {
      expect(code(file.text), file.name).not.toContain("console.");
    }
  });
});
