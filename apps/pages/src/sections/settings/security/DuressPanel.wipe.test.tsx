/** @vitest-environment jsdom */
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuressPanel } from "./DuressPanel.js";
import {
  CODE,
  dialog,
  resetDevice,
  typeCode,
} from "./DuressPanel.test-support.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const WIPE = "Wipe this device's copy";
const WORD = "Type WIPE to confirm";

function turnOn(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Turn on duress code" });
  if (!(button instanceof HTMLButtonElement)) throw new Error("not a button");
  return button;
}

const consent = () => screen.getByRole("checkbox") as HTMLInputElement;
const word = () => screen.getByLabelText(WORD) as HTMLInputElement;

/** The sheet open on the wipe mode, the code typed twice, nothing else done. */
async function openWipeSheet(arm = vi.fn(async () => ({ ok: true as const }))) {
  render(<DuressPanel arm={arm} />);
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await userEvent.click(screen.getByRole("radio", { name: WIPE }));
  await typeCode(CODE);
  return arm;
}

describe("DuressPanel wipe mode", () => {
  beforeEach(async () => {
    await resetDevice();
    await vaultStore.createWithPin("48291037");
  });
  afterEach(async () => {
    cleanup();
    await resetDevice();
    vaultStore.lock();
    await vaultStore.destroy();
  });

  it("is offered as the third choice, with its own sentence and a word to type", async () => {
    render(<DuressPanel arm={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      "Decoy vault",
      "Wrong password",
      WIPE,
    ]);
    expect(screen.queryByLabelText(WORD)).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: WIPE }));
    expect(word().value).toBe("");
    // The sheet never says the vault stays sealed for the one mode that removes it.
    expect(screen.queryByText(/stays sealed/)).toBeNull();
    expect(screen.getByText(/removed from this browser/)).toBeTruthy();
    const sentence = screen.getByText(
      /removes the vaults stored in this browser/,
    );
    for (const part of [
      "backup I made",
      "not what the disk may still hold",
      "how long the refusal takes may differ from a wrong password",
    ]) {
      expect(sentence.textContent).toContain(part);
    }
  });

  it("stays off until the word is typed and the sentence is ticked", async () => {
    await openWipeSheet();
    expect(turnOn().disabled).toBe(true);

    // The sentence alone is not enough.
    await userEvent.click(consent());
    expect(turnOn().disabled).toBe(true);

    // Nor a word that is not the word.
    for (const wrong of ["WIP", "WIPE IT", "wipe it", "delete"]) {
      await userEvent.clear(word());
      await userEvent.type(word(), wrong);
      expect(turnOn().disabled, wrong).toBe(true);
    }

    // The word alone is not enough either.
    await userEvent.click(consent());
    await userEvent.clear(word());
    await userEvent.type(word(), "WIPE");
    expect(consent().checked).toBe(false);
    expect(turnOn().disabled).toBe(true);

    await userEvent.click(consent());
    expect(turnOn().disabled).toBe(false);
  });

  it("is taken back, word and sentence both, when the mode changes", async () => {
    await openWipeSheet();
    await userEvent.type(word(), "WIPE");
    await userEvent.click(consent());
    expect(turnOn().disabled).toBe(false);

    await userEvent.click(screen.getByRole("radio", { name: "Decoy vault" }));
    expect(screen.queryByLabelText(WORD)).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: WIPE }));

    expect(word().value).toBe("");
    expect(consent().checked).toBe(false);
    expect(turnOn().disabled).toBe(true);
  });

  it("is not armed by a ticked sentence carried over from another mode", async () => {
    await openWipeSheet();
    await userEvent.click(
      screen.getByRole("radio", { name: "Wrong password" }),
    );
    await userEvent.click(consent());
    await userEvent.click(screen.getByRole("radio", { name: WIPE }));
    await userEvent.type(word(), "WIPE");
    expect(consent().checked).toBe(false);
    expect(turnOn().disabled).toBe(true);
  });

  it("arms the wipe mode with the typed word, and nothing else, once ready", async () => {
    const arm = await openWipeSheet();
    await userEvent.type(word(), " wipe ");
    await userEvent.click(consent());
    await userEvent.click(turnOn());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledWith(
      expect.objectContaining({
        code: CODE,
        mode: "wipe",
        extras: { confirm: " wipe " },
      }),
    );
  });
});
