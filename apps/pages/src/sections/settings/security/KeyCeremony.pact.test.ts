import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — Pages key ceremony", () => {
  it("passkey host repair survives the cross-origin localhost hop", () => {
    const src = readFileSync(join(here, "KeyCeremony.tsx"), "utf8");
    expect(src).toContain('searchParams.set(ENROLL_PASSKEY_PARAM, "1")');
    expect(src).toContain("window.location.assign(url)");
    expect(src).not.toContain("sessionStorage");
  });
});
