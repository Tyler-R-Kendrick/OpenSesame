/** Support chrome helpers for journey tests. */
import { screen, waitFor } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { expect } from "vitest";

export type JourneyUser = ReturnType<typeof userEvent.setup>;

export async function openSupport(user: JourneyUser): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: "Support" }));
  return screen.findByRole("dialog", { name: "Support" }, { timeout: 10_000 });
}

/** What the statusline mark says while a tutorial is running. */
export const TOURING = "Support — tutorial in progress";

/**
 * The way back in while a tutorial is live. The panel steps aside for one,
 * and the mark is what says so.
 */
export async function reopenSupport(user: JourneyUser): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: TOURING }));
  return screen.findByRole("dialog", { name: "Support" });
}

/** The tutorial card: its name is "Tutorial: <the tutorial's title>". */
export function tutorialCard(): Promise<HTMLElement> {
  return screen.findByRole(
    "dialog",
    { name: /^Tutorial:/ },
    { timeout: 10_000 },
  );
}

/** Presses Next on the tutorial card, as a person does. */
export async function nextStep(user: JourneyUser): Promise<void> {
  await user.click(
    await screen.findByRole("button", { name: /^Next/ }, { timeout: 10_000 }),
  );
}

/** Presses Done on the closing card. */
export async function finishTutorial(user: JourneyUser): Promise<void> {
  await user.click(
    await screen.findByRole("button", { name: /^Done/ }, { timeout: 10_000 }),
  );
}

/** Which step the card says it is on, by its "Step 2 of 5" counter. */
export async function stepOf(): Promise<string> {
  const card = await tutorialCard();
  const counter = card.querySelector(".coach__count")?.textContent ?? "";
  return counter;
}

export async function askSupport(
  user: JourneyUser,
  question: string,
): Promise<void> {
  const field = await screen.findByLabelText<HTMLInputElement>(
    "Ask about this screen",
  );
  await waitFor(() => expect(field.disabled).toBe(false), { timeout: 10_000 });
  await user.type(field, question);
  await user.click(screen.getByRole("button", { name: "Ask" }));
}

/** Counts clicks on one element, so "nothing activated it" can be asserted. */
export function countClicks(element: HTMLElement): () => number {
  let clicks = 0;
  element.addEventListener("click", () => {
    clicks += 1;
  });
  return () => clicks;
}
