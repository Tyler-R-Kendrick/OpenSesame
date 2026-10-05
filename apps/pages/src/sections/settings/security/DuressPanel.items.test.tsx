/** @vitest-environment jsdom */
import { duressStatus } from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import { DECOY_ITEMS } from "@opensesame/app-core/lib/duress/settings/modes/decoy-items.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuressPanel } from "./DuressPanel.js";
import {
  CODE,
  SEALING,
  arm,
  dialog,
  resetDevice,
  typeCode,
} from "./DuressPanel.test-support.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const MODE = DECOY_ITEMS.label;
const LIST = DECOY_ITEMS.input.label;
const go = () => screen.getByRole("button", { name: "Turn on duress code" });
const list = (): HTMLTextAreaElement => {
  const box = screen.getByRole("textbox", { name: LIST });
  if (!(box instanceof HTMLTextAreaElement)) throw new Error("not a textarea");
  return box;
};
const tick = (): HTMLInputElement => {
  const box = screen.getByRole("checkbox");
  if (!(box instanceof HTMLInputElement)) throw new Error("not a checkbox");
  return box;
};
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `Item ${i + 1}`).join("{enter}");

async function openItems() {
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await userEvent.click(screen.getByRole("radio", { name: MODE }));
}

async function retype(text: string) {
  await userEvent.clear(list());
  if (text) await userEvent.type(list(), text);
}

describe("DuressPanel, decoy with everyday items", () => {
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

  it("is offered as a mode, after the plain decoy and before the refusal", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const names = screen
      .getAllByRole("radio")
      .map((radio) => radio.closest("label")?.textContent);
    // Its place relative to its neighbours, not the whole list, so another
    // mode landing elsewhere does not break this.
    const at = names.indexOf(MODE);
    expect(names[at - 1]).toBe("Decoy vault");
    expect(names.indexOf("Wrong password")).toBeGreaterThan(at);
    expect(screen.queryByRole("textbox", { name: LIST })).toBeNull();
  });

  it("pre-fills the starter list when picked, so there is something to edit", async () => {
    render(<DuressPanel arm={arm} />);
    await openItems();
    expect(list().value).toBe(DECOY_ITEMS.input.starter.join("\n"));
    expect(screen.getByText(DECOY_ITEMS.opens)).toBeTruthy();
    // No second action to fetch it.
    expect(
      screen.queryByRole("button", { name: /starter|suggest/i }),
    ).toBeNull();
  });

  it("takes the list back when another mode is picked, and offers the starter afresh", async () => {
    render(<DuressPanel arm={arm} />);
    await openItems();
    await retype("Only{enter}my{enter}list");
    await userEvent.click(
      screen.getByRole("radio", { name: "Wrong password" }),
    );
    expect(screen.queryByRole("textbox", { name: LIST })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: MODE }));
    expect(list().value).toBe(DECOY_ITEMS.input.starter.join("\n"));
  });

  it("keeps arming off until there are 3 to 12 lines that fit, the code and this mode's consent", async () => {
    const { maxLength } = DECOY_ITEMS.input;
    render(<DuressPanel arm={arm} />);
    await openItems();
    await typeCode(CODE);
    await userEvent.click(tick());
    expect(go().hasAttribute("disabled")).toBe(false);

    await retype("");
    expect(go().hasAttribute("disabled")).toBe(true);
    await retype(lines(2));
    expect(go().hasAttribute("disabled")).toBe(true);
    await retype(`${lines(2)}{enter}{enter}   {enter}`);
    expect(go().hasAttribute("disabled")).toBe(true);
    await retype(lines(3));
    expect(go().hasAttribute("disabled")).toBe(false);
    await retype(lines(12));
    expect(go().hasAttribute("disabled")).toBe(false);
    await retype(lines(13));
    expect(go().hasAttribute("disabled")).toBe(true);
    await retype(`${lines(2)}{enter}${"x".repeat(maxLength + 1)}`);
    expect(go().hasAttribute("disabled")).toBe(true);
    await retype(`${lines(2)}{enter}${"x".repeat(maxLength)}`);
    expect(go().hasAttribute("disabled")).toBe(false);
  });

  it("asks for this mode's own consent, and a change of mode takes the tick back", async () => {
    render(<DuressPanel arm={arm} />);
    await openItems();
    expect(screen.getByText(DECOY_ITEMS.consent)).toBeTruthy();
    await typeCode(CODE);
    expect(tick().checked).toBe(false);
    expect(go().hasAttribute("disabled")).toBe(true);
    await userEvent.click(tick());
    expect(go().hasAttribute("disabled")).toBe(false);

    await userEvent.click(screen.getByRole("radio", { name: "Decoy vault" }));
    expect(tick().checked).toBe(false);
    await userEvent.click(screen.getByRole("radio", { name: MODE }));
    expect(tick().checked).toBe(false);
    expect(go().hasAttribute("disabled")).toBe(true);
  });

  it("arms with the lines as typed and says it is on", async () => {
    const seen = vi.fn(arm);
    render(<DuressPanel arm={seen} />);
    await openItems();
    await retype("Netflix{enter}Gym{enter}Spotify");
    await typeCode(CODE);
    await userEvent.click(tick());
    await userEvent.click(go());
    expect(
      await screen.findByText("Duress code is on.", {}, SEALING),
    ).toBeTruthy();
    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]?.[0]).toMatchObject({
      code: CODE,
      mode: "decoy_items",
      extras: { items: "Netflix\nGym\nSpotify" },
    });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(duressStatus().armed).toBe(true);
  });
});
