/** @vitest-environment jsdom */
import { MODES } from "@opensesame/app-core/lib/duress/settings/modes/index.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuressPanel } from "./DuressPanel.js";
import {
  arm,
  dialog,
  fields,
  heldArm,
  openAndFill,
  resetDevice,
} from "./DuressPanel.test-support.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

describe("DuressPanel sheet while arming", () => {
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

  it("does not close on Escape, the scrim or the close key until the write settles", async () => {
    const { slow, release } = heldArm({ ok: true });
    render(<DuressPanel arm={slow} />);
    await openAndFill();
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on duress code" }),
    );
    await waitFor(() =>
      expect(dialog()?.getAttribute("aria-busy")).toBe("true"),
    );
    await userEvent.keyboard("{Escape}");
    for (const close of screen.getAllByRole("button", { name: "Close" })) {
      expect(close.getAttribute("aria-disabled")).toBe("true");
      await userEvent.click(close);
    }
    expect(dialog()).not.toBeNull();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(await screen.findByText("Duress code is on.")).toBeTruthy();
  });

  it("stays open when the write fails, and then closes like any sheet", async () => {
    const { slow, release } = heldArm({ ok: false, code: "failed" });
    render(<DuressPanel arm={slow} />);
    await openAndFill();
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on duress code" }),
    );
    await userEvent.keyboard("{Escape}");
    expect(dialog()).not.toBeNull();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(dialog()?.getAttribute("aria-busy")).toBeNull());
    expect(screen.getByText("The code could not be set.")).toBeTruthy();
    expect(dialog()).not.toBeNull();
    expect(
      screen
        .getAllByRole("button", { name: "Close" })[0]
        ?.getAttribute("aria-disabled"),
    ).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("closes with the vault, so the next unlock opens no sheet", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(dialog()).not.toBeNull();
    act(() => vaultStore.lock());
    await waitFor(() => expect(dialog()).toBeNull());
    await act(async () => {
      await vaultStore.unlockWithPin("48291037");
    });
    expect(await screen.findByRole("button", { name: "Add" })).toBeTruthy();
    expect(dialog()).toBeNull();
    // Unlocking touches the tomb's files; let those writes land, with the
    // device still unlocked, before the next test destroys the tomb.
    await kvFlush();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await kvFlush();
  });
});

describe("DuressPanel acknowledgement", () => {
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

  it("is not carried to another outcome, nor back to the first", async () => {
    render(<DuressPanel arm={arm} />);
    await openAndFill();
    const go = screen.getByRole("button", { name: "Turn on duress code" });
    expect(go.hasAttribute("disabled")).toBe(false);
    await userEvent.click(
      screen.getByRole("radio", { name: "Wrong password" }),
    );
    const box = screen.getByRole("checkbox");
    expect(box instanceof HTMLInputElement && box.checked).toBe(false);
    expect(go.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "Decoy vault" }));
    expect(box instanceof HTMLInputElement && box.checked).toBe(false);
    expect(go.hasAttribute("disabled")).toBe(true);
  });

  it("is not carried to the next opening of the sheet", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog()).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const box = screen.getByRole("checkbox");
    expect(box instanceof HTMLInputElement && box.checked).toBe(false);
  });
});

describe("DuressPanel outcome choice", () => {
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

  it("is a native radio group, with no radiogroup role over plain buttons", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const group = screen.getByRole("group", { name: "Entering it shows" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("type"))).toEqual(
      MODES.map(() => "radio"),
    );
    // ARIA: a radiogroup owns radios. Any other child makes the role invalid.
    for (const owner of document.querySelectorAll("[role=radiogroup]")) {
      expect(
        owner.querySelectorAll("[role=radio], input[type=radio]").length,
      ).toBeGreaterThan(0);
      expect(owner.querySelector("button[aria-pressed]")).toBeNull();
    }
    expect(document.querySelector("[role=dialog] [aria-pressed]")).toBeNull();
  });

  it("draws one radio, one Opens line and one consent per registered mode", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const group = screen.getByRole("group", { name: "Entering it shows" });
    expect(group.querySelectorAll("ul > li")).toHaveLength(MODES.length);
    for (const mode of MODES) {
      await userEvent.click(screen.getByRole("radio", { name: mode.label }));
      expect(screen.getByText(mode.opens)).toBeTruthy();
      expect(screen.getByText(mode.consent)).toBeTruthy();
      for (const other of MODES) {
        if (other.id === mode.id) continue;
        expect(screen.queryByText(other.consent)).toBeNull();
      }
    }
  });

  it("is one native group, so the browser owns the arrows and Tab leaves in one press", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const radios = screen
      .getAllByRole("radio")
      .filter(
        (node): node is HTMLInputElement => node instanceof HTMLInputElement,
      );
    const [decoy] = radios;
    if (!decoy) throw new Error("no radio");
    // One name is what makes the arrows move the choice and Tab skip the rest.
    expect(decoy.name).not.toBe("");
    for (const radio of radios) {
      expect(radio.name).toBe(decoy.name);
      expect(radio.tabIndex).toBe(0);
    }
    decoy.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(fields()[0]);
  });
});
