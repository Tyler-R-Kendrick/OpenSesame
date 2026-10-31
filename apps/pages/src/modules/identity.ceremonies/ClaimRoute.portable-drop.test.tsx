/** @vitest-environment jsdom */
/**
 * A portable drop packet rides the `/claim` arrival into the opener.
 */
import { peekClaimArrival } from "@opensesame/app-core/lib/claims/arrival.js";
import { dropOpenSeams } from "@opensesame/app-core/lib/claims/drop-open.js";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEY,
  arrive,
  cleanupClaimRoutePage,
  resetClaimRoutePage,
  show,
} from "./ClaimRoute.test-support.js";

beforeEach(() => {
  resetClaimRoutePage();
});

afterEach(() => {
  cleanupClaimRoutePage();
});

describe("a drop link", () => {
  const presentClaim = dropOpenSeams.presentClaim;
  afterEach(() => {
    dropOpenSeams.presentClaim = presentClaim;
  });

  it("hands a portable packet from the arrival to the opener", async () => {
    const portable = `osc_pdrop_${"A".repeat(22)}.${"B".repeat(43)}`;
    const present = vi.fn(async () => {
      throw new Error("offline");
    });
    dropOpenSeams.presentClaim = present;
    arrive(`/claim#token=${portable}&key=${KEY}&pkt=ospd2.packet`);
    show();
    const code = await screen.findByLabelText("Code");
    await userEvent.type(code, "ABCD{Enter}");
    await waitFor(() =>
      expect(present).toHaveBeenCalledWith(portable, "ABCD", "ospd2.packet"),
    );
    expect(peekClaimArrival()).toMatchObject({
      kind: "drop",
      token: portable,
      key: KEY,
      pkt: "ospd2.packet",
    });
  });
});
