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
      "pages/Inbox.tsx",
      "pages/ApprovalReview.tsx",
      "pages/NotificationSettings.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/getSecret\s*\(/);
      expect(src, rel).not.toMatch(/access_token|refresh_token/);
    }
  });

  it("adversarial: the approval screens hold no bearer, subject, or comparison value", () => {
    // The three things this design says a human surface must never hold: the
    // session bearer (it lives in one transport function, not in a screen),
    // the authority-bearing half of a channel binding, and a comparison value
    // read back from anywhere but the field the person typed it into.
    for (const rel of [
      "pages/Inbox.tsx",
      "pages/ApprovalReview.tsx",
      "pages/NotificationSettings.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/providerSubjectId|providerTenantId/);
      expect(src, rel).not.toMatch(/Bearer\s|accessToken|authorization:/);
      // `comparisonValue` may be *written* into the settle body and nowhere
      // else; no screen may read one off a response.
      expect(src, rel).not.toMatch(/comparisonValue\s*[?.]/);
      expect(src, rel).not.toMatch(/\.value\b.*comparison/i);
    }
  });

  it("chaos: the review ceremony proves before it settles", () => {
    // The call order is the security property. Minting the activation against
    // the displayed digest, running the assertion, and only then settling is
    // what stops a decision existing before the proof of it does.
    assertSourceOrder(read("pages/ApprovalReview.tsx"), [
      "beginActivation(",
      "credentials.get(",
      "completeActivation(",
      "await settle(",
    ]);
    // …and the missing-credential-API branch returns before any of it.
    assertSourceOrder(read("pages/ApprovalReview.tsx"), [
      "credentialsApi()",
      "setDegraded(NO_CREDENTIALS_API)",
      "beginActivation(",
    ]);
  });

  it("contract: the notification screen leads with the assurance note", () => {
    const src = read("pages/NotificationSettings.tsx").replace(/\s+/g, " ");
    // The note is the first thing under the heading, before any control.
    assertSourceOrder(src, [
      "ASSURANCE_NOTE",
      "Channels this deployment has",
      "Your destinations",
    ]);
    expect(read("lib/notification-settings.ts").replace(/\s+/g, " ")).toContain(
      "Choosing where you're notified doesn't change what it takes to approve",
    );
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
