import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("nothing at boot", () => {
  it("the shell's boot path never imports the transport client", () => {
    for (const file of ["main.tsx", "App.tsx", "components/AppShell.tsx"]) {
      expect(
        readFileSync(join(import.meta.dirname, file), "utf8"),
        file,
      ).not.toMatch(/transport-(status|rows|agent-surface)/);
    }
  });
});
