/** @vitest-environment jsdom */
/**
 * What a reset left behind: a glyph per area on the row, and the areas that
 * would not go in the notifications tray, never as a sentence in the page.
 */
import {
  captureLandingReset,
  dismissLandingReset,
  resetLandingForTest,
} from "@opensesame/app-core/lib/browser-reset-landing.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, it } from "vitest";
import { expectInTray, inTray } from "../../components/tray.test-support.js";
import { ResetLeftNotice } from "./ResetLeftNotice.js";

afterEach(() => {
  cleanup();
  resetLandingForTest();
  window.history.replaceState(null, "", "/");
});

function arriveAt(address: string): void {
  window.history.replaceState(null, "", address);
  captureLandingReset();
}

describe("ResetLeftNotice", () => {
  it("trays the areas that would not go and marks each row", async () => {
    arriveAt("/?reset-failed=databases,origin_files");
    render(<ResetLeftNotice />);

    screen.getByRole("img", { name: "History backups: not erased" });
    screen.getByRole("img", { name: "Vaults and settings: not erased" });
    await expectInTray("History backups, Vaults and settings: not erased");
  });

  it("clears the notice when the row is dismissed", async () => {
    arriveAt("/?reset-failed=databases");
    render(<ResetLeftNotice />);
    await expectInTray("History backups: not erased");

    act(() => dismissLandingReset());
    await waitFor(() => {
      if (inTray("not erased")) throw new Error("notice outlived the row");
    });
  });

  it("sends nothing to the tray for areas only kept while offline", () => {
    arriveAt("/?reset-kept=caches");
    render(<ResetLeftNotice />);

    screen.getByRole("img", { name: "Offline app: kept while offline" });
    if (inTray("not erased")) throw new Error("kept area was trayed");
  });
});
