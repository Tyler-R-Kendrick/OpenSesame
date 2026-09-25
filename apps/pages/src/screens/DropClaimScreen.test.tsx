/** @vitest-environment jsdom */
/**
 * The drop opener `sharing.drops` hands the `/claim` route: the code, then
 * the payload decrypted under the key the link carried. A refusal is a mark
 * and a tray notice; one the link cannot come back from settles it.
 */
import { CLAIM_NOTICE } from "@opensesame/app-core/lib/claims/route-model.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  DropTransportError,
  dropSeams,
} from "@opensesame/app-core/lib/vault/drop-transport.js";
import { sealDrop } from "@opensesame/app-core/lib/vault/drop.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropClaimScreen } from "./DropClaimScreen.js";

const TOKEN = "osc_clm_pub.secret"; // gitleaks:allow -- synthetic claim-shaped test vector
const original = dropSeams.presentClaim;
const onSettled = vi.fn();

function trayed() {
  return listNotices().find((notice) => notice.id === CLAIM_NOTICE);
}

beforeEach(() => {
  clearNotices();
  onSettled.mockReset();
});

afterEach(() => {
  cleanup();
  dropSeams.presentClaim = original;
});

describe("DropClaimScreen", () => {
  it("opens a text drop under the link's key once the code is entered", async () => {
    const sealed = await sealDrop({
      kind: "text",
      name: "wifi",
      text: "correct horse",
    });
    const present = vi.fn(async () => ({ targetManifest: sealed.manifest }));
    dropSeams.presentClaim = present;
    render(
      <DropClaimScreen
        token={TOKEN}
        fragmentKey={sealed.fragmentKey}
        onSettled={onSettled}
      />,
    );
    const code = screen.getByLabelText("One-time code");
    await waitFor(() => expect(document.activeElement).toBe(code));
    await userEvent.type(code, "ABCD{Enter}");
    expect(await screen.findByText("correct horse")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Drop opened" })).toBeTruthy();
    expect(present).toHaveBeenCalledWith(TOKEN, "ABCD");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("keeps the link after a wrong code, marked and in the tray", async () => {
    dropSeams.presentClaim = vi.fn(async () => {
      throw new DropTransportError("invalid_code", "That code did not match.");
    });
    const { container } = render(
      <DropClaimScreen
        token={TOKEN}
        fragmentKey="a2V5"
        onSettled={onSettled}
      />,
    );
    await userEvent.type(screen.getByLabelText("One-time code"), "NOPE{Enter}");
    await waitFor(() => expect(trayed()?.title).toBe("Drop"));
    expect(
      screen.getByRole("img", { name: trayed()?.body ?? "" }),
    ).toBeTruthy();
    expect(container.querySelector(".note")).toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("settles a drop that was already opened", async () => {
    dropSeams.presentClaim = vi.fn(async () => {
      throw new DropTransportError("already_opened", "Already opened.");
    });
    render(
      <DropClaimScreen
        token={TOKEN}
        fragmentKey="a2V5"
        onSettled={onSettled}
      />,
    );
    await userEvent.type(screen.getByLabelText("One-time code"), "ABCD{Enter}");
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });
});
