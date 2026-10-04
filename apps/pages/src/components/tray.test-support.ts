import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

const matches = (body: string, text: string | RegExp): boolean =>
  text instanceof RegExp ? text.test(body) : body.includes(text);

/** Whether the tray holds a status notice whose body carries `text`. */
export function inTray(text: string | RegExp): boolean {
  return listNotices().some(
    (notice) => notice.kind === "status" && matches(notice.body, text),
  );
}

/**
 * A failure's home is the notifications tray, never the page: wait for the
 * sentence to land in the tray, and check nothing in the page repeats it or
 * announces it.
 */
export async function expectInTray(text: string | RegExp): Promise<void> {
  await waitFor(() => expect(inTray(text)).toBe(true));
  expect(matches(document.body.textContent ?? "", text)).toBe(false);
  expect(
    document.querySelector('[role="alert"]:not(.visually-hidden)'),
  ).toBeNull();
}
