/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { matchMediaFor } from "../lib/use-narrow.test-fake.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { CommandBar, commandPlaceholder } from "./CommandBar.js";

const original = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], status: "unlocked" }),
  useCopySecret: () => async () => ({ ok: true as const, clearsInMs: 0 }),
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => {
  Object.assign(vaultHooksSeams, original);
});

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", matchMediaFor(coarse));
}

function placeholder(): string | null {
  render(
    <MemoryRouter initialEntries={["/vault"]}>
      <CommandBar />
    </MemoryRouter>,
  );
  return screen
    .getByRole("combobox", { name: "Command" })
    .getAttribute("placeholder");
}

describe("the command bar's hint", () => {
  it("keeps the whole desktop line with a mouse", () => {
    pointer(false);
    expect(placeholder()).toBe("go to vault · search · copy password for …");
  });

  it("says a short line a phone's field can show whole", () => {
    pointer(true);
    const hint = placeholder();
    expect(hint).toBe("go · search · copy");
    // The 320px field is ~18 mono characters wide; the desktop line is cut.
    expect((hint ?? "").length).toBeLessThanOrEqual(18);
  });

  it("has a touch twin for the ask road too", () => {
    expect(commandPlaceholder(true, false)).toBe(
      "Command or ask… copy password for github",
    );
    expect(commandPlaceholder(true, true)).toBe("Command or ask…");
  });
});
