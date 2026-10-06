import { describe, expect, it } from "vitest";
import {
  type CredentialStore,
  authenticatedPort,
} from "../../packages/app-core/src/lib/password-agent/auth.js";
import { password } from "../../packages/app-core/src/lib/password-agent/password.js";
import type {
  InvokeOptions,
  PasswordAgentPort,
} from "../../packages/app-core/src/lib/password-agent/transport.js";
const sentinel = "FICTIONAL-SECRET-UNRELATED";
const login = () => ({
  id: "a".repeat(26),
  title: "Login",
  category: "LOGIN",
  vault: { id: "b".repeat(26), name: "Work" },
  tags: ["automation"],
  urls: [{ href: "https://example.test" }],
  sections: [{ id: "extra", label: "Other" }],
  fields: [
    {
      id: "password",
      label: "password",
      purpose: "PASSWORD",
      type: "CONCEALED",
      value: "old",
    },
    {
      id: "username",
      label: "User",
      type: "STRING",
      value: sentinel,
      section: { id: "extra" },
    },
  ],
});
describe("2password write preservation", () => {
  it("rejects whitespace-only password candidates before provider access", async () => {
    let calls = 0;
    const port: PasswordAgentPort = {
      async invoke() {
        calls++;
        return "";
      },
    };
    await expect(
      password(port, { item: "Login", vault: "Work", apply: true }, " \r\n\t "),
    ).rejects.toThrow("non-empty password");
    expect(calls).toBe(0);
  });
  it.each(["value", "label", "section", "tags", "urls", "sections", "vault"])(
    "rejects changed unrelated %s without retry or secret leakage",
    async (key) => {
      let stored = login();
      let edits = 0;
      const port: PasswordAgentPort = {
        async invoke(args, options) {
          if (args[1] === "edit") {
            edits++;
            stored = JSON.parse(options.input ?? "{}");
            if (key === "value" || key === "label")
              Object.assign(stored.fields[1] ?? {}, { [key]: "corrupted" });
            else if (key === "section")
              Object.assign(stored.fields[1] ?? {}, {
                section: { id: "changed" },
              });
            else if (key === "tags") stored.tags = [];
            else if (key === "urls") stored.urls = [];
            else if (key === "sections") stored.sections = [];
            else stored.vault.name = "Other";
            return JSON.stringify(stored);
          }
          return JSON.stringify(stored);
        },
      };
      const failure = await password(
        port,
        { item: "Login", vault: "Work", apply: true },
        "new",
      ).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("unverified");
      expect(String(failure)).not.toContain(sentinel);
      expect(edits).toBe(1);
    },
  );
  it("threads selected authentication into a batched resolver", async () => {
    let selected: InvokeOptions | undefined;
    const port: PasswordAgentPort = {
      async invoke() {
        return "";
      },
      async readMany(_refs, options) {
        selected = options;
        return ["resolved"];
      },
    };
    const store: CredentialStore = {
      storage: "test",
      async hasToken() {
        return true;
      },
      async loadToken() {
        return "ops_fictional";
      },
      async loadSettings() {
        return undefined;
      },
      async saveToken() {},
      async removeToken() {},
      async saveSettings() {},
      async removeSettings() {},
    };
    const secured = authenticatedPort(port, store);
    expect(await secured.readMany?.(["op://Work/Key/credential"])).toEqual([
      "resolved",
    ]);
    expect(selected?.env).toEqual(
      expect.objectContaining({
        OP_SERVICE_ACCOUNT_TOKEN: "ops_fictional",
        OP_CONNECT_TOKEN: undefined,
      }),
    );
  });
});
