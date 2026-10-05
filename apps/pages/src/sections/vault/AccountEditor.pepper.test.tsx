/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  enablePepper,
  usePassword,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import { passwordMethod } from "@opensesame/vault-core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  block,
  input,
  installEditorHarness,
  open,
  passwordOf,
  saveItem,
  saved,
  typeInPrompt,
  vault,
} from "./account-editor.test-support.js";
import { makeAccount } from "./account.test-support.js";

describe("account editor: pepper", () => {
  installEditorHarness();

  it("seals a password under a pepper typed twice, and saves no plaintext", async () => {
    open("/vault/new/account");
    const password = block("Password");
    await userEvent.click(
      password.getByRole("button", { name: "Show password" }),
    );
    const plaintext = input("Password").value;
    expect(plaintext.length).toBeGreaterThan(8);

    await userEvent.click(password.getByLabelText("Include pepper"));
    const dialog = screen.getByRole("dialog", { name: "Set pepper" });
    expect(within(dialog).getByLabelText("Confirm pepper")).toBeTruthy();
    await typeInPrompt("peppercorn", true);
    await userEvent.click(screen.getByRole("button", { name: "Set pepper" }));
    await waitFor(() =>
      expect(
        password.getByLabelText<HTMLInputElement>("Include pepper").checked,
      ).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // Focus came back to the box that asked.
    expect(document.activeElement).toBe(
      password.getByLabelText("Include pepper"),
    );

    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const item = saved();
    const method = passwordOf(item);
    expect(method.pepper).toBe(true);
    expect(method.secret).toBe("");
    expect(method.sealed).toBeDefined();
    const wire = JSON.stringify(item);
    expect(wire).not.toContain(plaintext);
    expect(wire).not.toContain("peppercorn");
    // Only the right pepper opens it, and it opens to what the editor showed.
    expect(await usePassword(item, method, async () => "peppercorn")).toBe(
      plaintext,
    );
  });

  it("asks for the pepper once at Save when a peppered password is new", async () => {
    const account = makeAccount({ id: "itm_1", password: "old-password" });
    const method = passwordMethod(account);
    if (!method) throw new Error("fixture");
    const sealed = await enablePepper(
      account.id,
      method,
      "old-password",
      "right",
    );
    vault.current = {
      items: [{ ...account, methods: [sealed] }],
      folders: [],
    };
    open("/vault/itm_1/edit");
    // Sealed and unknown: nothing to show, nothing to reveal.
    expect(input("Password").value).toBe("");
    expect(screen.queryByRole("button", { name: "Show password" })).toBeNull();

    const fresh = "fresh-typed-password";
    await userEvent.type(input("Password"), fresh);
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await userEvent.type(await screen.findByLabelText("Pepper"), "left");
    await userEvent.type(screen.getByLabelText("Confirm pepper"), "left");
    await userEvent.click(screen.getByRole("button", { name: "Set pepper" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalledTimes(1));
    const item = saved();
    const next = passwordOf(item);
    expect(next.secret).toBe("");
    expect(JSON.stringify(item)).not.toContain(fresh);
    expect(await usePassword(item, next, async () => "left")).toBe(fresh);
  }, 20_000);

  it("saves nothing when the pepper prompt at Save is closed, and returns focus to Save", async () => {
    const account = makeAccount({ id: "itm_1" });
    const method = passwordMethod(account);
    if (!method) throw new Error("fixture");
    vault.current = {
      items: [{ ...account, methods: [{ ...method, pepper: true }] }],
      folders: [],
    };
    open("/vault/itm_1/edit");
    await userEvent.type(input("Password"), "typed-new");
    const save = screen.getByRole("button", { name: "Save item" });
    await userEvent.click(save);
    expect(
      await screen.findByRole("dialog", { name: "Set pepper" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saveItem).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(save);
    // Closing the prompt is a decision, not a failure.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a wrong pepper as a mark and a tray notice, never a box", async () => {
    const account = makeAccount({ id: "itm_1", password: "old-password" });
    const method = passwordMethod(account);
    if (!method) throw new Error("fixture");
    const sealed = await enablePepper(
      account.id,
      method,
      "old-password",
      "right",
    );
    vault.current = {
      items: [{ ...account, methods: [sealed] }],
      folders: [],
    };
    const { container } = open("/vault/itm_1/edit");
    const password = block("Password");
    await userEvent.click(password.getByLabelText("Include pepper"));
    await userEvent.type(
      await screen.findByLabelText("Pepper"),
      "wrong{Enter}",
    );
    expect(
      await password.findByRole("img", { name: "Wrong pepper" }),
    ).toBeTruthy();
    expect(listNotices().some((n) => n.id === `pepper:${sealed.id}`)).toBe(
      true,
    );
    expect(container.querySelector(".note")).toBeNull();
    expect(container.querySelector(".conn-flash")).toBeNull();
    // Still peppered: a wrong pepper changed nothing.
    expect(
      password.getByLabelText<HTMLInputElement>("Include pepper").checked,
    ).toBe(true);

    await userEvent.click(password.getByLabelText("Include pepper"));
    await userEvent.type(
      await screen.findByLabelText("Pepper"),
      "right{Enter}",
    );
    await waitFor(() =>
      expect(
        password.getByLabelText<HTMLInputElement>("Include pepper").checked,
      ).toBe(false),
    );
    expect(password.queryByRole("img", { name: "Wrong pepper" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(passwordOf(saved())).toMatchObject({
      pepper: false,
      secret: "old-password",
    });
    expect(passwordOf(saved()).sealed).toBeUndefined();
  }, 20_000);
});
