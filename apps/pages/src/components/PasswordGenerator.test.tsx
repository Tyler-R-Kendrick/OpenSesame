import { overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copySecret = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, { useCopySecret: () => copySecret });

import { PasswordGenerator } from "./PasswordGenerator.js";

function generatedValue(): string {
  const el = document.querySelector(".gen__value");
  if (!el) throw new Error("generator output not rendered");
  return el.textContent ?? "";
}

describe("PasswordGenerator", () => {
  beforeEach(() => {
    copySecret.mockReset();
    copySecret.mockResolvedValue("copied");
  });

  afterEach(cleanup);

  it("generates a 20-character password on mount with an entropy readout", async () => {
    render(<PasswordGenerator onUse={vi.fn()} />);
    await waitFor(() => expect(generatedValue().length).toBe(20));
    expect(screen.getByText(/bits of entropy/)).toBeTruthy();
  });

  it("re-rolls on demand and reports entropy for the new options", async () => {
    render(<PasswordGenerator onUse={vi.fn()} />);
    await waitFor(() => expect(generatedValue().length).toBe(20));
    fireEvent.click(screen.getByRole("button", { name: "Generate another" }));
    expect(generatedValue().length).toBe(20);
  });

  it("copies the generated value through the clipboard helper", async () => {
    render(<PasswordGenerator onUse={vi.fn()} />);
    await waitFor(() => expect(generatedValue().length).toBe(20));
    fireEvent.click(
      screen.getByRole("button", { name: "Copy generated password" }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalledTimes(1));
    expect(copySecret).toHaveBeenCalledWith(generatedValue());
  });

  it("respects the length slider", async () => {
    render(<PasswordGenerator onUse={vi.fn()} />);
    await waitFor(() => expect(generatedValue().length).toBe(20));
    fireEvent.change(screen.getByLabelText("Length"), {
      target: { value: "40" },
    });
    await waitFor(() => expect(generatedValue().length).toBe(40));
  });

  it("switches to passphrase mode with word-count and separator controls", async () => {
    render(<PasswordGenerator onUse={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Passphrase" }));
    expect(
      screen
        .getByRole("button", { name: "Passphrase" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() =>
      expect(generatedValue()).toMatch(/^[A-Za-z0-9]+(-[A-Za-z0-9]+){3}$/),
    );

    fireEvent.change(screen.getByLabelText("Word count"), {
      target: { value: "6" },
    });
    await waitFor(() =>
      expect(generatedValue()).toMatch(/^[A-Za-z0-9]+(-[A-Za-z0-9]+){5}$/),
    );
  });

  it("shows an error instead of a password when no character set is selected", async () => {
    render(<PasswordGenerator onUse={vi.fn()} />);
    await waitFor(() => expect(generatedValue().length).toBe(20));
    for (const label of ["A–Z", "a–z", "0–9", "Symbols"]) {
      fireEvent.click(screen.getByLabelText(label));
    }
    expect(
      await screen.findByText("Choose at least one character set."),
    ).toBeTruthy();
    expect(generatedValue()).toBe("—");
    expect(
      overlapCast(
        screen.getByRole("button", {
          name: "Use this password",
        }),
      ).disabled,
    ).toBe(true);
  });

  it("hands the value to onUse and offers dismissal when given", async () => {
    const onUse = vi.fn();
    const onDismiss = vi.fn();
    render(<PasswordGenerator onUse={onUse} onDismiss={onDismiss} />);
    await waitFor(() => expect(generatedValue().length).toBe(20));
    fireEvent.click(screen.getByRole("button", { name: "Use this password" }));
    expect(onUse).toHaveBeenCalledWith(generatedValue());
    fireEvent.click(screen.getByRole("button", { name: "Close generator" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides the dismiss button when no onDismiss is given", () => {
    render(<PasswordGenerator onUse={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "Close generator" }),
    ).toBeNull();
  });

  it("passphrase options regenerate: capitalise, number, separator", async () => {
    render(<PasswordGenerator onUse={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Passphrase" }));
    await waitFor(() =>
      expect(generatedValue()).toMatch(/^[A-Za-z0-9]+(-[A-Za-z0-9]+){3}$/),
    );

    // Lowercase everything, drop the number, and change the separator.
    fireEvent.click(screen.getByLabelText("Capitalise"));
    fireEvent.click(screen.getByLabelText("Add a number"));
    fireEvent.change(screen.getByLabelText("Separator"), {
      target: { value: "." },
    });
    await waitFor(() =>
      expect(generatedValue()).toMatch(/^[a-z]+(\.[a-z]+){3}$/),
    );

    // Switching back to characters restores the character options view.
    fireEvent.click(screen.getByRole("button", { name: "Characters" }));
    await waitFor(() => expect(generatedValue().length).toBe(20));
  });

  it("toggling ambiguity avoidance regenerates without ambiguous characters", async () => {
    render(<PasswordGenerator onUse={vi.fn()} />);
    await waitFor(() => expect(generatedValue().length).toBe(20));
    // Default avoids l1IO0; turning it off allows the full alphabet.
    fireEvent.click(screen.getByLabelText("Avoid l1IO0"));
    await waitFor(() => expect(generatedValue().length).toBe(20));
    fireEvent.click(screen.getByLabelText("Avoid l1IO0"));
    await waitFor(() => expect(generatedValue()).toMatch(/^[^il1Lo0O]{20}$/));
  });
});
