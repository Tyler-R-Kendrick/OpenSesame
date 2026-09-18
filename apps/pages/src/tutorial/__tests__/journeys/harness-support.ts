/** Support chrome helpers for journey tests. */
import { screen, waitFor } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { expect } from "vitest";

export type JourneyUser = ReturnType<typeof userEvent.setup>;

export async function openSupport(user: JourneyUser): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: "Support" }));
  return screen.findByRole("dialog", { name: "Support" }, { timeout: 10_000 });
}

/**
 * The way back in while a walkthrough is live. The panel steps aside for one,
 * and the overlay is what says so.
 */
export async function reopenSupport(user: JourneyUser): Promise<HTMLElement> {
  await user.click(
    await screen.findByRole("button", {
      name: "Support — walkthrough in progress",
    }),
  );
  return screen.findByRole("dialog", { name: "Support" });
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
