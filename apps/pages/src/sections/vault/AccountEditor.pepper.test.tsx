/** @vitest-environment jsdom */
import {
  passwordMethod,
  pepperBinding,
  sealWithPepper,
} from "@opensesame/vault-core";
import { screen, waitFor } from "@testing-library/react";
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
  vault,
} from "./account-editor.test-support.js";
import { makeAccount } from "./account.test-support.js";

describe("account editor: pepper (ADR 0174)", () => {
  installEditorHarness();

  it("turns Include pepper on without asking for one, and draws where it goes only then", async () => {
    open("/vault/new/account");
    const password = block("Password");
    expect(password.queryByLabelText("Pepper goes")).toBeNull();
    await userEvent.click(password.getByLabelText("Include pepper"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText("Pepper")).toBeNull();
    const at = password.getByLabelText("Pepper goes");
    expect(at.getAttribute("placeholder")).toBe("end");
    await userEvent.click(password.getByLabelText("Include pepper"));
    expect(password.queryByLabelText("Pepper goes")).toBeNull();
  });

  it("saves the password and where the pepper goes, and never a pepper or a seal", async () => {
    open("/vault/new/account");
    const password = block("Password");
    await userEvent.click(
      password.getByRole("button", { name: "Show password" }),
    );
    const shown = input("Password").value;
    expect(shown.length).toBeGreaterThan(8);
    await userEvent.click(password.getByLabelText("Include pepper"));
    await userEvent.type(password.getByLabelText("Pepper goes"), "-3");
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const method = passwordOf(saved());
    expect(method).toMatchObject({ pepper: true, pepperAt: "-3" });
    expect(method.sealed).toBeUndefined();
    // A new password is algorithmic: what is kept is its root, not what it computed.
    expect(method.generator.id).toBe("derived");
    expect(method.secret).not.toBe(shown);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("takes a Python-style position, and marks one that is not, keeping the last good one", async () => {
    open("/vault/new/account");
    const password = block("Password");
    await userEvent.click(password.getByLabelText("Include pepper"));
    const at = password.getByLabelText("Pepper goes");
    await userEvent.type(at, "2:5");
    expect(password.queryByRole("img")).toBeNull();
    await userEvent.clear(at);
    await userEvent.type(at, "middle");
    expect(
      password.getByRole("img", {
        name: "Not a position: try end, 3, -2 or 2:5",
      }),
    ).toBeTruthy();
    await userEvent.clear(at);
    await userEvent.type(at, "-2");
    expect(password.queryByRole("img")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(passwordOf(saved()).pepperAt).toBe("-2");
  });

  it("keeps where a pepper goes through an edit and forgets it when the pepper is turned off", async () => {
    const account = makeAccount({ id: "itm_1", password: "old-password" });
    const method = passwordMethod(account);
    if (!method) throw new Error("fixture");
    vault.current = {
      items: [
        { ...account, methods: [{ ...method, pepper: true, pepperAt: "4" }] },
      ],
      folders: [],
    };
    open("/vault/itm_1/edit");
    const password = block("Password");
    expect(password.getByLabelText<HTMLInputElement>("Pepper goes").value).toBe(
      "4",
    );
    await userEvent.click(password.getByLabelText("Include pepper"));
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const next = passwordOf(saved());
    expect(next.pepper).toBe(false);
    expect(next.pepperAt).toBeUndefined();
    expect(next.secret).toBe("old-password");
  });

  it("converts a password an earlier pepper sealed, in the editor, and then edits it as a stored one", async () => {
    const account = makeAccount({ id: "itm_1", password: "old-password" });
    const method = passwordMethod(account);
    if (!method) throw new Error("fixture");
    vault.current = {
      items: [
        {
          ...account,
          methods: [
            {
              ...method,
              pepper: true,
              secret: "",
              sealed: await sealWithPepper(
                "old-password",
                "right",
                pepperBinding(account.id, method.id),
              ),
            },
          ],
        },
      ],
      folders: [],
    };
    open("/vault/itm_1/edit");
    const password = block("Password");
    expect(password.queryByLabelText("Include pepper")).toBeNull();
    await userEvent.click(
      password.getByRole("button", { name: "Convert password" }),
    );
    await userEvent.type(
      await screen.findByLabelText("Earlier pepper"),
      "right{Enter}",
    );
    expect(await password.findByLabelText("Include pepper")).toBeTruthy();
    expect(input("Password").value).toBe("old-password");
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const next = passwordOf(saved());
    expect(next).toMatchObject({ pepper: false, secret: "old-password" });
    expect(next.sealed).toBeUndefined();
  }, 20_000);
});
