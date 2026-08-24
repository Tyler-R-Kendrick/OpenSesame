import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const read = (rel: string) => readFileSync(join(here, rel), "utf8");

describe("PACT — hosted ceremony pages", () => {
  it("adversarial: the frame refusal sits before anything renders", () => {
    assertSourceOrder(read("main.tsx"), [
      "refusing to render inside a frame",
      "createRoot(root).render",
    ]);
  });

  it("adversarial: no page source names raw credential fields", () => {
    for (const rel of [
      "App.tsx",
      "pages/ClaimCeremony.tsx",
      "pages/GuestSession.tsx",
      "pages/DeviceApprove.tsx",
      "pages/DelegateClaim.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/getSecret\s*\(/);
      expect(src, rel).not.toMatch(/access_token|refresh_token/);
    }
  });

  it("chaos: the claim ceremony scrubs the fragment before presenting", () => {
    assertSourceOrder(read("pages/ClaimCeremony.tsx"), [
      "readFragmentToken(window.location.hash)",
      "history.replaceState",
      "void load(fromLink, false)",
    ]);
  });

  it("chaos: the delegate ceremony scrubs the fragment before presenting", () => {
    // The stub-era rule was "never calls out"; the live ceremony's rule is
    // stricter where it matters: the bearer leaves the URL before any network
    // call spends it, and presenting happens exactly once — a failure after
    // that point must not re-present, because a second present burns the
    // offer for everyone.
    const src = read("pages/DelegateClaim.tsx");
    assertSourceOrder(src, [
      "readFragmentToken",
      "history.replaceState",
      "void present(token)",
    ]);
    expect(src).toContain("presenting it spends it");
    // The consent code is required client-side before the claim call, so a
    // missing code never costs a network round trip against a spent token.
    assertSourceOrder(src, [
      "const code = userCode.trim()",
      "delegations/claim",
    ]);
  });

  it("contract: guest identity copy never claims to show a credential", () => {
    // The formatter may re-wrap JSX copy, so compare with whitespace folded.
    expect(read("pages/GuestSession.tsx").replace(/\s+/g, " ")).toContain(
      "never shows raw credentials",
    );
  });
});
