/** @vitest-environment jsdom */
import {
  clearNotices,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { Notices } from "../../components/Notices.js";
import type { WordmarkHandle } from "../../components/Wordmark.js";
import { FrontDoor } from "../FrontDoor.js";
import { UnlockStage } from "./UnlockStage.js";

function raiseNotice() {
  act(() => {
    setStatusNotice({
      id: "unlock:code",
      tone: "err",
      title: "Unlock code",
      body: "Use the code delivered to this device.",
    });
  });
}

afterEach(() => {
  cleanup();
  clearNotices();
});

describe("the lock-v5 screens own their notification region", () => {
  it("keeps the refusal and bell before the unlock form while release notes stay available", async () => {
    render(
      <MemoryRouter>
        <Notices shellless>
          <UnlockStage
            paneRef={createRef<HTMLDivElement>()}
            cardRef={createRef<HTMLDivElement>()}
            notesRef={createRef<HTMLElement>()}
            wordmarkRef={createRef<WordmarkHandle>()}
            ceremonyToken={0}
            vaultUnlocked={false}
          >
            <form className="unlock__form" aria-label="Unlock">
              <input aria-label="PIN" />
              <button type="submit">Unlock</button>
            </form>
          </UnlockStage>
        </Notices>
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "PIN" }), "2468");
    raiseNotice();
    const bell = screen.getByRole("button", {
      name: "Notifications — 1 pending",
    });
    expect(bell.closest(".gate-notice-seat")?.parentElement?.className).toBe(
      "unlock__card",
    );
    const stage = bell.closest(".unlock--lock-v5");
    const corner = bell.closest(".notice-corner");
    const form = screen.getByRole("form", { name: "Unlock" });
    expect(stage).toBeTruthy();
    if (!(corner instanceof HTMLElement))
      throw new Error("The refusal and bell must own a notice region.");
    expect(within(corner).getByRole("alert").textContent).toContain(
      "Use the code delivered to this device.",
    );
    expect(corner.closest(".unlock__card")).toBe(form.parentElement);
    expect(form.contains(corner)).toBe(false);
    expect(
      corner.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The stage contains both regions; its outer box cannot be the boundary
    // used to prove that the notice is above the form it precedes.
    expect(stage?.contains(corner)).toBe(true);
    expect(stage?.contains(form)).toBe(true);
    const notes = screen.getByRole("complementary", { name: "Release notes" });
    expect(notes.contains(bell)).toBe(false);
    expect(screen.getByDisplayValue("2468")).toBeTruthy();
    await userEvent.click(bell);
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Release notes" })).toBe(
      notes,
    );
  });

  it("keeps the front-door bell in its own card instead of behind release notes", async () => {
    render(
      <MemoryRouter>
        <Notices shellless>
          <FrontDoor
            onOpenSetup={() => undefined}
            onOpenJoin={() => undefined}
          />
        </Notices>
      </MemoryRouter>,
    );
    raiseNotice();
    const bell = screen.getByRole("button", {
      name: "Notifications — 1 pending",
    });
    expect(
      bell
        .closest(".gate-notice-seat")
        ?.parentElement?.classList.contains("door__card"),
    ).toBe(true);
    expect(
      screen
        .getByRole("complementary", { name: "Release notes" })
        .contains(bell),
    ).toBe(false);
    await userEvent.click(bell);
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Set up your own" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join a session" })).toBeTruthy();
  });
});
