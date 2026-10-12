/** @vitest-environment jsdom */
import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  asked,
  enter,
  host,
  hosted,
  installLiveFocusTests,
  landsOn,
  openJoin,
  press,
  type,
} from "./live-focus-test-support.js";

installLiveFocusTests();

describe("the keyboard after the host's swaps", () => {
  it("lands on the copy key when Start opens the session, and on the form when End closes it", async () => {
    const panel = await host();
    press(panel.getByRole("button", { name: "Start the live session" }));
    const copy = await panel.findByRole("button", { name: "Copy the link" });
    await landsOn(copy);
    press(panel.getByRole("button", { name: "End the session for everyone" }));
    press(panel.getByRole("button", { name: "End for everyone" }));
    const name = await panel.findByLabelText("Session name");
    await landsOn(name);
  });

  it("brings the copy key out from under the phone's sticky strip when Start shortens the page", async () => {
    const panel = await host();
    const pane = document.body.firstElementChild;
    if (!(pane instanceof HTMLElement)) throw new Error("no pane to scroll");
    const strip = pane.appendChild(document.createElement("nav"));
    strip.className = "page-index";
    strip.style.position = "sticky";
    pane.style.overflowY = "auto";
    Object.defineProperty(pane, "scrollHeight", { value: 2000 });
    Object.defineProperty(pane, "clientHeight", { value: 640 });
    pane.scrollTop = 100;
    const rect = (top: number, height: number) =>
      new DOMRect(0, top, 0, height);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this === pane) return rect(0, 640);
        if (this === strip) return rect(0, 52);
        return rect(98 - pane.scrollTop, 44);
      },
    );
    press(panel.getByRole("button", { name: "Start the live session" }));
    await landsOn(await panel.findByRole("button", { name: "Copy the link" }));
    expect(pane.scrollTop).toBe(38);
  });

  it("leaves a mouse user where they are when the session starts", async () => {
    const panel = await host();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    act(() => elsewhere.focus());
    fireEvent.click(
      panel.getByRole("button", { name: "Start the live session" }),
    );
    await panel.findByRole("img", { name: "Live" });
    await landsOn(elsewhere);
    elsewhere.remove();
  });

  it("returns to the request field after a paste, and lands on the reply code after Let in", async () => {
    const { panel, session } = await hosted();
    const joiner = openJoin();
    const request = await asked(joiner, session?.code ?? "");
    const field = panel.getByLabelText("A request code");
    type(field, request);
    enter(field);
    const letIn = await panel.findByRole("button", { name: "Let Ada in" });
    await landsOn(panel.getByLabelText("A request code"));
    press(letIn);
    const reply = await panel.findByRole("button", {
      name: "Copy the reply code for Ada",
    });
    await landsOn(reply);
  });

  it("returns to the request field after Turn away, and after a code it cannot read", async () => {
    const { panel, session } = await hosted();
    const joiner = openJoin();
    const request = await asked(joiner, session?.code ?? "");
    const field = panel.getByLabelText("A request code");
    type(field, "not a code");
    enter(field);
    await panel.findByRole("img", { name: "Not a request code" });
    await landsOn(panel.getByLabelText("A request code"));
    type(panel.getByLabelText("A request code"), request);
    enter(panel.getByLabelText("A request code"));
    press(await panel.findByRole("button", { name: "Turn Ada away" }));
    await panel.findByRole("img", { name: "Turned away" });
    await landsOn(panel.getByLabelText("A request code"));
  });

  it("does not move a mouse user's focus when a guest is turned away", async () => {
    const { panel, session } = await hosted();
    const joiner = openJoin();
    const request = await asked(joiner, session?.code ?? "");
    type(panel.getByLabelText("A request code"), request);
    enter(panel.getByLabelText("A request code"));
    const away = await panel.findByRole("button", { name: "Turn Ada away" });
    const other = document.createElement("input");
    document.body.append(other);
    act(() => other.focus());
    fireEvent.click(away);
    await panel.findByRole("img", { name: "Turned away" });
    await landsOn(other);
    other.remove();
  });
});
