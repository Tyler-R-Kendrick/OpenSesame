/** @vitest-environment jsdom */
import { requireLoginDraft } from "@opensesame/app-core/lib/vault/login-draft.js";
import { act, screen, waitFor } from "@testing-library/react";
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
} from "./account-editor.test-support.js";

describe("account editor: methods and generators", () => {
  installEditorHarness();

  it("draws the account, not a login, at the legacy route too", () => {
    open("/vault/new/login");
    expect(screen.getByText(".account")).toBeTruthy();
    expect(screen.getByLabelText("Username / ID")).toBeTruthy();
    expect(screen.getByText("Login methods")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Password method" })).toBeTruthy();
  });

  it("starts with one password block and adds each method type from the picker", async () => {
    open("/vault/new/account");
    expect(
      screen.getAllByRole("group", { name: /^Password.* method$/ }),
    ).toHaveLength(1);
    const adds: [string, string, RegExp][] = [
      ["API key", "API key", /^API key$/],
      ["Token", "Token", /^Token$/],
      ["OAuth", "OAuth", /^Client id$/],
      ["Authenticator", "Authenticator", /^Authenticator secret$/],
    ];
    for (const [choice, group, field] of adds) {
      await userEvent.click(
        screen.getByRole("button", { name: "Add login method" }),
      );
      await userEvent.click(screen.getByRole("button", { name: choice }));
      expect(block(group).getByLabelText(field)).toBeTruthy();
      // The new block takes focus on its first field.
      expect(document.activeElement).toBe(block(group).getByLabelText(field));
    }
    await userEvent.click(
      screen.getByRole("button", { name: "Add login method" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Password" }));
    expect(
      screen.getByRole("group", { name: "Password 1 method" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Password 2 method" }),
    ).toBeTruthy();
  });

  it("closes the picker with Escape and puts focus back on the +", async () => {
    open("/vault/new/account");
    const plus = screen.getByRole("button", { name: "Add login method" });
    await userEvent.click(plus);
    expect(
      screen.getByRole("group", { name: "Login method type" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("group", { name: "Login method type" }),
    ).toBeNull();
    expect(document.activeElement).toBe(plus);
  });

  it("saves api key, token and oauth fields as typed", async () => {
    open("/vault/new/account");
    for (const choice of ["API key", "Token", "OAuth"]) {
      await userEvent.click(
        screen.getByRole("button", { name: "Add login method" }),
      );
      await userEvent.click(screen.getByRole("button", { name: choice }));
    }
    await userEvent.type(block("API key").getByLabelText("API key"), "ak_1");
    await userEvent.type(block("Token").getByLabelText("Token"), "tok_1");
    await userEvent.type(block("OAuth").getByLabelText("Client id"), "cid");
    await userEvent.type(
      block("OAuth").getByLabelText("Token URL"),
      "https://x.test/t",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(saved().methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "api-key",
          key: "ak_1",
          header: "X-Api-Key",
        }),
        expect.objectContaining({ type: "token", token: "tok_1" }),
        expect.objectContaining({
          type: "oauth",
          clientId: "cid",
          tokenUrl: "https://x.test/t",
        }),
      ]),
    );
  });

  it("publishes the editor to WebMCP as metadata only, whatever the password holds", async () => {
    open("/vault/new/account?uri=https://bank.example.com");
    await userEvent.selectOptions(
      block("Password").getByLabelText("Password generator"),
      "sphinx",
    );
    const port = requireLoginDraft();
    const view = port.read();
    expect(Object.keys(view).sort()).toEqual([
      "favorite",
      "folderId",
      "folderName",
      "folders",
      "name",
      "url",
      "username",
      "websites",
    ]);
    act(() => {
      port.patch({ username: "set-by-agent" });
    });
    expect(input("Username / ID").value).toBe("set-by-agent");
  });

  it("removes a method, even the last one", async () => {
    open("/vault/new/account");
    await userEvent.click(
      screen.getByRole("button", { name: "Remove password" }),
    );
    expect(screen.queryByRole("group", { name: "Password method" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(saved().methods).toEqual([]);
  });

  it("changes the options with the generator", async () => {
    open("/vault/new/account");
    const password = block("Password");
    const select = password.getByLabelText("Password generator");
    expect(password.getByLabelText("Length")).toBeTruthy();
    expect(password.getByLabelText("Minimum digits")).toBeTruthy();
    expect(password.getByLabelText("Minimum symbols")).toBeTruthy();
    expect(password.getByLabelText("Avoid l1IO0")).toBeTruthy();

    await userEvent.selectOptions(select, "passphrase");
    expect(password.getByLabelText("Word count")).toBeTruthy();
    expect(password.getByLabelText("Separator")).toBeTruthy();
    expect(password.queryByLabelText("Length")).toBeNull();
    expect(
      password
        .getByLabelText("Password", { selector: "input" })
        .getAttribute("type"),
    ).toBe("password");

    await userEvent.selectOptions(select, "sphinx");
    expect(password.getByLabelText("Counter")).toBeTruthy();
    expect(password.getByLabelText("Length")).toBeTruthy();
    // Computed on use: no password field, a mark and a rotate key instead.
    expect(
      password.queryByLabelText("Password", { selector: "input" }),
    ).toBeNull();
    expect(password.getByRole("img", { name: /never stored/ })).toBeTruthy();

    await userEvent.selectOptions(select, "manual");
    expect(password.queryByLabelText("Length")).toBeNull();
    expect(password.queryByLabelText("Word count")).toBeNull();
    expect(
      password.getByLabelText("Password", { selector: "input" }),
    ).toBeTruthy();
    expect(
      password.queryByRole("button", { name: "Generate another password" }),
    ).toBeNull();
  });

  it("offers Include pepper for every generator but Sphinx, and no disabled stand-in", async () => {
    open("/vault/new/account");
    const password = block("Password");
    const select = password.getByLabelText("Password generator");
    for (const id of ["rules", "passphrase", "manual"]) {
      await userEvent.selectOptions(select, id);
      expect(password.getByLabelText("Include pepper")).toBeTruthy();
    }
    await userEvent.selectOptions(select, "sphinx");
    expect(password.queryByLabelText("Include pepper")).toBeNull();
    expect(screen.queryByText("Include pepper")).toBeNull();
  });

  it("saves a Sphinx method with a key and no password at all", async () => {
    open("/vault/new/account?uri=https://bank.example.com");
    await userEvent.selectOptions(
      block("Password").getByLabelText("Password generator"),
      "sphinx",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Rotate password" }),
    );
    expect(input("Counter").value).toBe("1");
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const method = passwordOf(saved());
    expect(method).toMatchObject({ secret: "", pepper: true });
    expect(method.sealed).toBeUndefined();
    expect(method.generator).toMatchObject({
      id: "sphinx",
      realm: "bank.example.com",
      counter: 1,
    });
  });
});
