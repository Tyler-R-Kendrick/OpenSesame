/** @vitest-environment jsdom */
/**
 * The pre-unlock outcome banner: a stored outcome renders in the right tone,
 * dismissal clears the record, and silence stays silent. A deferred account
 * link renders nothing here — the bell's "finish attaching" prompt owns that
 * state once the vault is open.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readAuthOutcome, storeAuthOutcome } from "../../lib/auth-outcome.js";
import { clearNotices, pushNotice } from "../../lib/notices.js";
import { PendingLinkBanner } from "./PendingLinkBanner.js";

afterEach(() => {
  cleanup();
  clearNotices();
  sessionStorage.clear();
});

describe("PendingLinkBanner", () => {
  it("renders nothing when there is no outcome", () => {
    const { container } = render(<PendingLinkBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a pending-link notice — the bell owns that prompt", () => {
    pushNotice({
      kind: "federated_link",
      title: "Finish attaching your sign-in",
      body: "…",
    });

    const { container } = render(<PendingLinkBanner />);

    expect(container.firstChild).toBeNull();
  });

  it("renders a linked outcome with the signer's name", () => {
    storeAuthOutcome({ kind: "linked", who: "sam@acme.com" });

    render(<PendingLinkBanner />);

    expect(screen.getByText(/Signed in as sam@acme.com/)).toBeTruthy();
  });

  it("renders a link failure with its stored detail", () => {
    storeAuthOutcome({ kind: "link_failed", detail: "Identity unreachable." });

    render(<PendingLinkBanner />);

    expect(screen.getByText("Identity unreachable.")).toBeTruthy();
  });

  it("dismisses a stored outcome and clears the record", () => {
    storeAuthOutcome({ kind: "linked", who: "sam@acme.com" });

    render(<PendingLinkBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(readAuthOutcome()).toBeNull();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });
});

describe("PendingLinkBanner — the roads out of an account", () => {
  it("says a plain sign-out happened", () => {
    storeAuthOutcome({ kind: "signed_out" });
    render(<PendingLinkBanner />);
    expect(screen.getByText("Signed out of this device.")).toBeTruthy();
  });

  it("asks which account to sign in with after a switch", () => {
    storeAuthOutcome({ kind: "signed_out", switching: true });
    render(<PendingLinkBanner />);
    expect(
      screen.getByText("Signed out. Choose the account to sign in with."),
    ).toBeTruthy();
  });

  it("asks which account to attach", () => {
    storeAuthOutcome({ kind: "attach" });
    render(<PendingLinkBanner />);
    expect(screen.getByText(/Choose an account to attach/)).toBeTruthy();
  });
});
