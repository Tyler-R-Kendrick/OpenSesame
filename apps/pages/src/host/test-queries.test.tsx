/** @vitest-environment jsdom */
/**
 * `test-queries.ts` drops the document dump from a miss inside a poll. What
 * a person reads when a query fails must not change: every failure, waited
 * or not, still prints the document, and prints it once.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

afterEach(cleanup);

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** How many times a failure message printed the rendered document. */
function dumps(message: string): number {
  return message.replace(ANSI, "").split('data-marker="here"').length - 1;
}

async function failureOf(wait: Promise<HTMLElement>): Promise<string> {
  try {
    await wait;
  } catch (caught) {
    if (caught instanceof Error) return caught.message;
  }
  return "";
}

it("prints the document once when a find times out", async () => {
  render(<div data-marker="here">hi</div>);
  const failure = await failureOf(
    screen.findByRole("button", { name: "nope" }, { timeout: 100 }),
  );
  expect(failure).toContain('Unable to find role="button"');
  expect(dumps(failure)).toBe(1);
});

it("prints the document once when a waitFor on a query times out", async () => {
  render(<div data-marker="here">hi</div>);
  const failure = await failureOf(
    waitFor(() => screen.getByText("nope"), { timeout: 100 }),
  );
  expect(failure).toContain("Unable to find an element with the text");
  expect(dumps(failure)).toBe(1);
});

it("keeps the full diagnostics of a query outside a wait", () => {
  render(<div data-marker="here">hi</div>);
  let failure = "";
  try {
    screen.getByRole("button", { name: "nope" });
  } catch (caught) {
    if (caught instanceof Error) failure = caught.message;
  }
  expect(failure).toContain("accessible roles");
  expect(dumps(failure)).toBe(1);
});
