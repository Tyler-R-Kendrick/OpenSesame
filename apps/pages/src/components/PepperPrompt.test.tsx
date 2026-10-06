/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PepperCancelled,
  isPepperCancelled,
  usePepperPrompt,
} from "./PepperPrompt.js";

afterEach(cleanup);

function Harness({
  onValue,
  onFail,
}: {
  onValue: (value: string) => void;
  onFail: (reason: Error) => void;
}) {
  const { ask, element } = usePepperPrompt();
  return (
    <>
      <button
        type="button"
        onClick={() => void ask("Reveal password").then(onValue, onFail)}
      >
        open
      </button>
      {element}
    </>
  );
}

function setup() {
  const onValue = vi.fn();
  const onFail = vi.fn();
  render(<Harness onValue={onValue} onFail={onFail} />);
  return {
    onValue,
    onFail,
    opener: screen.getByRole("button", { name: "open" }),
  };
}

describe("PepperPrompt", () => {
  it("opens as a named modal with focus in the field, and resolves what was typed on Enter", async () => {
    const { onValue, opener } = setup();
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Reveal password" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const field = screen.getByLabelText("Pepper");
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    // One field and no confirmation: nothing is sealed under it.
    expect(screen.queryByLabelText("Confirm pepper")).toBeNull();
    await userEvent.keyboard("white pepper{Enter}");
    await waitFor(() => expect(onValue).toHaveBeenCalledWith("white pepper"));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The value goes with the sheet: it is nowhere in the document.
    expect(document.body.innerHTML).not.toContain("white pepper");
  });

  it("offers no commit until there is something to commit", async () => {
    const { opener } = setup();
    await userEvent.click(opener);
    const use = screen.getByRole<HTMLButtonElement>("button", {
      name: "Use pepper",
    });
    expect(use.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Pepper"), "x");
    expect(use.disabled).toBe(false);
  });

  it("reveals the typed value from an eye key, and hides it again", async () => {
    const { opener } = setup();
    await userEvent.click(opener);
    await userEvent.type(screen.getByLabelText("Pepper"), "abc");
    await userEvent.click(screen.getByRole("button", { name: "Show pepper" }));
    expect(screen.getByLabelText("Pepper").getAttribute("type")).toBe("text");
    await userEvent.click(screen.getByRole("button", { name: "Hide pepper" }));
    expect(screen.getByLabelText("Pepper").getAttribute("type")).toBe(
      "password",
    );
  });

  it("is cancelled by Escape from the keyboard, rejects, and hands focus back", async () => {
    const { onValue, onFail, opener } = setup();
    await userEvent.click(opener);
    await userEvent.keyboard("secret");
    // The first Escape leaves the text field for its sheet, the second closes.
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onFail).toHaveBeenCalledTimes(1));
    expect(isPepperCancelled(onFail.mock.calls[0]?.[0])).toBe(true);
    expect(onFail.mock.calls[0]?.[0]).toBeInstanceOf(PepperCancelled);
    expect(onValue).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps Tab inside the sheet", async () => {
    const { opener } = setup();
    await userEvent.click(opener);
    await userEvent.type(screen.getByLabelText("Pepper"), "x");
    for (let step = 0; step < 6; step += 1) {
      await userEvent.tab();
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
        true,
      );
    }
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );
  });

  it("names the field it was asked to, for an earlier master input", async () => {
    function Named({ onValue }: { onValue: (value: string) => void }) {
      const { ask, element } = usePepperPrompt();
      return (
        <>
          <button
            type="button"
            onClick={() => void ask("Convert", "Master input").then(onValue)}
          >
            go
          </button>
          {element}
        </>
      );
    }
    const onValue = vi.fn();
    render(<Named onValue={onValue} />);
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await userEvent.type(screen.getByLabelText("Master input"), "m{Enter}");
    await waitFor(() => expect(onValue).toHaveBeenCalledWith("m"));
  });
});
