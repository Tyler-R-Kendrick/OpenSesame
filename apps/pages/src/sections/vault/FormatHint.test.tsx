/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormatHint } from "./FormatHint.js";
import { FormatHintMatch } from "./FormatHintMatch.js";

afterEach(cleanup);

const supabase = `sbp_${"a".repeat(40)}`;
const stripe = `sk_test_${"a".repeat(24)}`;

describe("format hints at the editing boundary", () => {
  it("loads the actual issuer recognizer without rendering the credential", async () => {
    const view = render(<FormatHint typeId="api-key" value={supabase} />);
    expect(
      await screen.findByText(
        "Recognised format: Supabase personal access token",
      ),
    ).toBeTruthy();
    expect(view.container.textContent).not.toContain(supabase);
    expect(view.container.querySelector("input")).toBeNull();
  });

  it("uses the current props as edited values change or become empty", async () => {
    const view = render(<FormatHint typeId="secret" value={supabase} />);
    view.rerender(<FormatHint typeId="secret" value="4242424242424242" />);
    expect(
      await screen.findByText("Recognised format: Payment card"),
    ).toBeTruthy();
    expect(screen.queryByText(/Supabase/u)).toBeNull();
    view.rerender(<FormatHint typeId="secret" value="" />);
    await waitFor(() => expect(view.container.textContent).toBe(""));
  });

  it.each([
    ["password", supabase, null],
    ["secret", "a secret with no issuer shape", null],
    ["secret", "person@example.test", null],
    ["email-account", "person@example.test", "Email address"],
    ["gift-card", "4242424242424242", "Gift-card number"],
    ["secret", stripe, "Stripe secret key"],
  ] as const)(
    "preserves exact/fallback recognition for %s",
    (typeId, value, label) => {
      const view = render(<FormatHintMatch typeId={typeId} value={value} />);
      expect(view.container.textContent).toBe(
        label === null ? "" : `Recognised format: ${label}`,
      );
      expect(view.container.textContent).not.toContain(value);
    },
  );

  it("keeps blank editor fields empty", () => {
    const view = render(<FormatHint value="   " />);
    expect(view.container.textContent).toBe("");
  });
});
