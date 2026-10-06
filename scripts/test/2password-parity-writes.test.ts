import { describe, expect, it } from "vitest";
import { createApiCredential } from "../../packages/app-core/src/lib/password-agent/create.js";
import { password } from "../../packages/app-core/src/lib/password-agent/password.js";
import type {
  InvokeOptions,
  PasswordAgentPort,
} from "../../packages/app-core/src/lib/password-agent/transport.js";
const sentinel = "FICTIONAL-SECRET-NEVER-IN-OUTPUT";
interface FixtureField {
  id?: string;
  label?: string;
  type: string;
  purpose?: string;
  value: string;
}
interface FixtureItem {
  id: string;
  title: string;
  category: string;
  vault: { id: string; name: string };
  fields: FixtureField[];
  passkeys?: { value: string }[];
}

function writer(
  category = "API_CREDENTIAL",
  failure?: "write" | "read" | "mismatch",
) {
  const calls: { args: readonly string[]; options: InvokeOptions }[] = [];
  let stored: FixtureItem = {
    id: "a".repeat(26),
    title: "Key",
    category,
    vault: { id: "b".repeat(26), name: "Work" },
    fields: [
      {
        id: "password",
        type: "CONCEALED",
        purpose: "PASSWORD",
        value: "OLD-SECRET",
      },
      { id: "username", type: "STRING", value: "unchanged" },
    ],
  };
  const port: PasswordAgentPort = {
    async invoke(args, options) {
      calls.push({ args, options });
      if (args[1] === "list") return "[]";
      if (args[1] === "create" || args[1] === "edit") {
        if (failure === "write") throw new Error(sentinel);
        stored = { ...stored, ...JSON.parse(options.input ?? "{}") };
      }
      if (
        args[1] === "get" &&
        calls.some(
          (call) => call.args[1] === "create" || call.args[1] === "edit",
        )
      ) {
        if (failure === "read") throw new Error(sentinel);
        if (failure === "mismatch")
          return JSON.stringify({ ...stored, title: "Wrong" });
      }
      return JSON.stringify(stored);
    },
  };
  return {
    port,
    calls,
    setItem(value: Partial<FixtureItem>) {
      stored = { ...stored, ...value };
    },
  };
}
describe("2password parity core", () => {
  it("create.private-input", async () => {
    const fake = writer();
    await createApiCredential(
      fake.port,
      { title: " Key ", vault: " Work " },
      `${sentinel}\r\n`,
    );
    const template = JSON.parse(
      fake.calls.find((call) => call.args[1] === "create")?.options.input ??
        "{}",
    );
    expect(template.fields[0].value).toBe(sentinel);
    for (const destination of [
      { title: " ", vault: "Work" },
      { title: "Key", vault: " " },
    ])
      await expect(
        createApiCredential(fake.port, destination, sentinel),
      ).rejects.toThrow("required");
    await expect(
      createApiCredential(fake.port, { title: "Key", vault: "Work" }, " \n"),
    ).rejects.toThrow("required");
  });
  it("create.duplicates", async () => {
    let writes = 0;
    const port: PasswordAgentPort = {
      async invoke(args) {
        if (args[1] !== "list") writes++;
        return JSON.stringify([{ title: " KEY " }]);
      },
    };
    await expect(
      createApiCredential(port, { title: "Key", vault: "Work" }, sentinel),
    ).rejects.toThrow("already exists");
    expect(writes).toBe(0);
  });
  it("create.verified", async () => {
    const fake = writer();
    const result = await createApiCredential(
      fake.port,
      {
        title: "Key",
        vault: "Work",
        url: "https://example.test",
        notes: "operations",
        account: "account",
      },
      sentinel,
    );
    expect(result).toEqual(
      expect.objectContaining({
        verified: true,
        ref: `op://${"b".repeat(26)}/${"a".repeat(26)}/credential`,
      }),
    );
    expect(fake.calls.map((call) => call.args[1])).toEqual([
      "list",
      "create",
      "get",
    ]);
    expect(fake.calls.every((call) => call.options.account === "account")).toBe(
      true,
    );
    expect(
      JSON.stringify(result) +
        JSON.stringify(fake.calls.map((call) => call.args)),
    ).not.toContain(sentinel);
  });
  it("create.uncertain", async () => {
    for (const failure of ["write", "read", "mismatch"] as const) {
      const fake = writer("API_CREDENTIAL", failure);
      const error = await createApiCredential(
        fake.port,
        { title: "Key", vault: "Work" },
        sentinel,
      ).catch((value: Error) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("unverified");
      expect(String(error)).not.toContain(sentinel);
      expect(
        fake.calls.filter((call) => call.args[1] === "create"),
      ).toHaveLength(1);
    }
  });
  it("password.compare", async () => {
    const fake = writer("LOGIN");
    const result = await password(
      fake.port,
      { item: "Key", vault: "Work" },
      `${sentinel}\n`,
    );
    expect(result).toEqual(expect.objectContaining({ matches: false }));
    expect(fake.calls.map((call) => call.args[1])).toEqual(["get"]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    const blank = writer("LOGIN");
    await expect(
      password(blank.port, { item: "Key", vault: "Work" }, " \r\n"),
    ).rejects.toThrow();
    expect(blank.calls).toHaveLength(0);
  });
  it("password.apply", async () => {
    const fake = writer("LOGIN");
    expect(
      await password(
        fake.port,
        { item: "Key", vault: "Work", apply: true },
        `${sentinel}\n`,
      ),
    ).toEqual(expect.objectContaining({ changed: true, verified: true }));
    const template = JSON.parse(fake.calls[1]?.options.input ?? "{}");
    expect(template.fields[0].value).toBe(`${sentinel}\n`);
    expect(template.fields[1].value).toBe("unchanged");
    expect(fake.calls.map((call) => call.args[1])).toEqual([
      "get",
      "edit",
      "get",
    ]);
    expect(
      await password(
        fake.port,
        { item: "Key", vault: "Work", apply: true },
        `${sentinel}\n`,
      ),
    ).toEqual(expect.objectContaining({ changed: false, verified: true }));
    expect(fake.calls.filter((call) => call.args[1] === "edit")).toHaveLength(
      1,
    );
  });
  it("password.unsafe-template", async () => {
    const fake = writer("LOGIN");
    fake.setItem({ passkeys: [{ value: sentinel }] });
    await expect(
      password(
        fake.port,
        { item: "Key", vault: "Work", apply: true },
        sentinel,
      ),
    ).rejects.toThrow("passkeys");
    expect(fake.calls.filter((call) => call.args[1] === "edit")).toHaveLength(
      0,
    );
    const imported = writer("LOGIN");
    imported.setItem({
      fields: [
        {
          id: "password",
          purpose: "PASSWORD",
          type: "CONCEALED",
          value: "old",
        },
        { type: "STRING", value: "preserve" },
      ],
    });
    await expect(
      password(
        imported.port,
        { item: "Key", vault: "Work", apply: true },
        sentinel,
      ),
    ).rejects.toThrow("explicit repair");
    expect(
      await password(
        imported.port,
        { item: "Key", vault: "Work", apply: true, repairImportedFields: true },
        sentinel,
      ),
    ).toEqual(expect.objectContaining({ verified: true }));
    expect(
      JSON.parse(
        imported.calls.find((call) => call.args[1] === "edit")?.options.input ??
          "{}",
      ).fields[1],
    ).toEqual({
      id: "imported_field_2",
      label: "Imported field 2",
      type: "CONCEALED",
      value: "preserve",
    });
  });
  it("password.uncertain", async () => {
    for (const failure of ["write", "read", "mismatch"] as const) {
      const fake = writer("LOGIN", failure);
      const error = await password(
        fake.port,
        { item: "Key", vault: "Work", apply: true },
        sentinel,
      ).catch((value: Error) => value);
      expect(String(error)).toContain("unverified");
      expect(String(error)).not.toContain(sentinel);
      expect(fake.calls.filter((call) => call.args[1] === "edit")).toHaveLength(
        1,
      );
    }
  });
});
