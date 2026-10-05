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
      "derived",
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
    expect(password.getByLabelText("Fewest numbers")).toBeTruthy();
    expect(password.getByLabelText("Fewest symbols")).toBeTruthy();
    expect(password.getByLabelText("Avoid look-alike characters")).toBeTruthy();

    await userEvent.selectOptions(select, "passphrase");
    expect(password.getByLabelText("Word count")).toBeTruthy();
    expect(password.getByLabelText("Separator")).toBeTruthy();
    expect(password.queryByLabelText("Length")).toBeNull();
    expect(
      password
        .getByLabelText("Password", { selector: "input" })
        .getAttribute("type"),
    ).toBe("password");

    await userEvent.selectOptions(select, "derived");
    // The rules shape the computed password; there is no counter to type.
    expect(password.getByLabelText("Length")).toBeTruthy();
    expect(password.queryByLabelText("Counter")).toBeNull();
    expect(
      password.getByRole("button", { name: "Generate another password" }),
    ).toBeTruthy();

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

  it("offers Include pepper on the generation form for every generator it lists, and the earlier Sphinx is not among them", async () => {
    open("/vault/new/account");
    const password = block("Password");
    const select = password.getByLabelText("Password generator");
    const offered = [...select.querySelectorAll("option")].map(
      (option) => option.value,
    );
    expect(offered).toEqual(["derived", "rules", "passphrase", "manual"]);
    for (const id of offered) {
      await userEvent.selectOptions(select, id);
      expect(password.getByLabelText("Include pepper")).toBeTruthy();
    }
  });

  it("saves a derived method as a root and rotates it with the counter", async () => {
    open("/vault/new/account?uri=https://bank.example.com");
    const password = block("Password");
    await userEvent.selectOptions(
      password.getByLabelText("Password generator"),
      "derived",
    );
    const shown = () => input("Password");
    await userEvent.click(
      password.getByRole("button", { name: "Show password" }),
    );
    const first = shown().value;
    expect(first).toHaveLength(20);
    await userEvent.click(
      password.getByRole("button", { name: "Generate another password" }),
    );
    const rotated = shown().value;
    expect(rotated).not.toBe(first);
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const method = passwordOf(saved());
    expect(method.generator).toMatchObject({ id: "derived", counter: 1 });
    // What is stored is the root, not the password the person saw.
    expect(method.secret).toHaveLength(44);
    expect(method.secret).not.toBe(rotated);
    expect(method.pepper).toBe(false);
    expect(method.sealed).toBeUndefined();
  });

  it("keeps the same algorithmic password when the pepper goes on: the root stays, a slot appears", async () => {
    open("/vault/new/account");
    const password = block("Password");
    await userEvent.selectOptions(
      password.getByLabelText("Password generator"),
      "derived",
    );
    await userEvent.click(
      password.getByRole("button", { name: "Show password" }),
    );
    const before = input("Password").value;
    await userEvent.click(password.getByLabelText("Include pepper"));
    expect(input("Password").value).toBe(before);
    await userEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const method = passwordOf(saved());
    expect(method).toMatchObject({ pepper: true });
    expect(method.secret).toHaveLength(44);
    expect(method.sealed).toBeUndefined();
    expect(method.generator).toMatchObject({ id: "derived", counter: 0 });
  });
});
