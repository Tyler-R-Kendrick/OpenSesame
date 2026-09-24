import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function pairwiseSub(sector: string): string {
  const digest = Array.from(
    new TextEncoder().encode(`${sector}:demo-principal`),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `pw_${digest}`;
}

describe("PACT — example relying party", () => {
  it("property: pairwise sub differs by sector", () => {
    expect(pairwiseSub("https://alpha.example.test")).not.toBe(
      pairwiseSub("https://beta.example.test"),
    );
  });

  it("adversarial: RpApp source never prints a canonical principal id", () => {
    const src = readFileSync(join(here, "RpApp.tsx"), "utf8");
    expect(src).toContain("Canonical principal ids");
    expect(src).toContain("never shown");
    expect(src).not.toMatch(/getSecret\s*\(/);
  });

  it("chaos: redirect callback replaces the URL so the code is not left in history", () => {
    assertSourceOrder(readFileSync(join(here, "RpApp.tsx"), "utf8"), [
      "handleRedirectCallback",
      'history.replaceState(null, "", "/")',
    ]);
  });

  it("contract: issuer defaults to loopback identity API", () => {
    const src = readFileSync(join(here, "RpApp.tsx"), "utf8");
    expect(src).toContain("http://127.0.0.1:8788");
    expect(src).not.toMatch(/access_token|client_secret/);
  });
});
