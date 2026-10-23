/** @vitest-environment jsdom */
import {
  anyDirtyEdit,
  resetDirtyEdits,
} from "@opensesame/app-core/lib/dirty-edit.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { watchDirtyForms } from "./dirty-forms.js";

afterEach(() => {
  cleanup();
  resetDirtyEdits();
});

function ControlledName() {
  const [name, setName] = useState("Bank");
  return (
    <form className="editor">
      <input
        aria-label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" />
    </form>
  );
}

function appendForm(className: string, control: HTMLElement): HTMLFormElement {
  const form = document.createElement("form");
  if (className) form.className = className;
  const submit = document.createElement("button");
  submit.type = "submit";
  form.append(control, submit);
  document.body.append(form);
  return form;
}

describe("dirty forms", () => {
  it("holds a controlled field until the value returns to the one at the edit", () => {
    const stop = watchDirtyForms();
    render(<ControlledName />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(anyDirtyEdit()).toBe(false);
    fireEvent.input(input, { target: { value: "Bank note" } });
    expect(anyDirtyEdit()).toBe(true);
    fireEvent.input(input, { target: { value: "Bank" } });
    expect(anyDirtyEdit()).toBe(false);
    stop();
  });

  it("holds an uncontrolled field and lets undo clear it", () => {
    const stop = watchDirtyForms();
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Name");
    const form = appendForm("editor", input);
    input.value = "Dirty";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(anyDirtyEdit()).toBe(true);
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(anyDirtyEdit()).toBe(false);
    form.remove();
    stop();
  });

  it("ignores a switch outside an editor", () => {
    const stop = watchDirtyForms();
    const box = document.createElement("input");
    box.type = "checkbox";
    const form = appendForm("", box);
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(anyDirtyEdit()).toBe(false);
    form.remove();
    stop();
  });

  it("drops the hold when a single dirty control leaves a still-mounted form", async () => {
    const stop = watchDirtyForms();
    const input = document.createElement("input");
    const form = appendForm("editor", input);
    input.value = "Dirty";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(anyDirtyEdit()).toBe(true);
    input.remove();
    await Promise.resolve();
    expect(anyDirtyEdit()).toBe(false);
    expect(form.isConnected).toBe(true);
    form.remove();
    stop();
  });

  it("drops the hold when a subtree containing the dirty control is removed", async () => {
    const stop = watchDirtyForms();
    const input = document.createElement("input");
    const wrapper = document.createElement("div");
    wrapper.append(input);
    const form = appendForm("editor", wrapper);
    input.value = "Dirty";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(anyDirtyEdit()).toBe(true);
    wrapper.remove();
    await Promise.resolve();
    expect(anyDirtyEdit()).toBe(false);
    form.remove();
    stop();
  });

  it("releases a dirty hold when the watcher stops", () => {
    const stop = watchDirtyForms();
    const input = document.createElement("input");
    const form = appendForm("editor", input);
    input.value = "Dirty";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(anyDirtyEdit()).toBe(true);
    stop();
    expect(anyDirtyEdit()).toBe(false);
    form.remove();
  });

  it("drops the hold when the edit is committed or the form leaves", async () => {
    const stop = watchDirtyForms();
    const input = document.createElement("input");
    const form = appendForm("editor", input);
    input.value = "Dirty";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(anyDirtyEdit()).toBe(true);
    form.dispatchEvent(new Event("os-edit-committed", { bubbles: true }));
    expect(anyDirtyEdit()).toBe(false);
    input.value = "Again";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(anyDirtyEdit()).toBe(true);
    form.remove();
    await Promise.resolve();
    expect(anyDirtyEdit()).toBe(false);
    stop();
  });
});
