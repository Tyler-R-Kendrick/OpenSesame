import { describe, expect, it } from "vitest";
import { password } from "./password.js";
import {
  type PasswordAgentPort,
  type RecordValue,
  record,
} from "./transport.js";

const itemId = "a".repeat(26);
const vaultId = "b".repeat(26);
const options = { item: "fixture login", vault: "fixture vault", apply: true };
interface ProviderCall {
  args: readonly string[];
  input?: string;
}
function login(): RecordValue {
  return {
    id: itemId,
    title: "fixture login",
    category: "LOGIN",
    vault: { id: vaultId, name: "fixture vault" },
    fields: [
      {
        id: "password",
        purpose: "PASSWORD",
        type: "CONCEALED",
        value: "fixture original",
      },
      {
        id: "username",
        purpose: "USERNAME",
        type: "STRING",
        value: "fixture user",
      },
    ],
    sections: [{ id: "custom", label: "fixture section" }],
    tags: ["fixture"],
    urls: [{ href: "https://example.com", primary: true }],
    notesPlain: "fixture note",
  };
}
function fixture(item = login()) {
  let stored = item;
  const calls: ProviderCall[] = [];
  let editFailure = false;
  let readback: ((item: RecordValue) => RecordValue) | undefined;
  const port: PasswordAgentPort = {
    async invoke(args, settings) {
      const call: ProviderCall = { args };
      if (settings.input !== undefined) call.input = settings.input;
      calls.push(call);
      if (args[1] === "edit") {
        if (editFailure) throw new Error("private transport diagnostic");
        stored = record(JSON.parse(settings.input ?? "null"));
        return JSON.stringify(stored);
      }
      return JSON.stringify(
        calls.length > 1 && readback ? readback(stored) : stored,
      );
    },
  };
  return {
    port,
    calls,
    stored: () => stored,
    failEdit: () => {
      editFailure = true;
    },
    readback: (transform: (item: RecordValue) => RecordValue) => {
      readback = transform;
    },
  };
}

describe("password-agent inspect/edit/readback", () => {
  it("compares without writes and recognizes an unchanged apply", async () => {
    const test = fixture();
    expect(
      await password(test.port, { ...options, apply: false }, "different"),
    ).toMatchObject({ matches: false });
    expect(
      await password(test.port, options, "fixture original"),
    ).toMatchObject({ changed: false, verified: true });
    expect(test.calls.every((call) => call.args[1] === "get")).toBe(true);
  });

  it("edits by canonical identity and preserves the entire login template", async () => {
    const test = fixture();
    const result = await password(test.port, options, "fixture replacement");
    expect(result).toEqual({
      id: itemId,
      title: "fixture login",
      vault: "fixture vault",
      ref: `op://${vaultId}/${itemId}/password`,
      changed: true,
      verified: true,
    });
    expect(test.calls[1]?.args).toEqual([
      "item",
      "edit",
      itemId,
      "--vault",
      vaultId,
      "--format",
      "json",
    ]);
    expect(test.calls[2]?.args).toEqual([
      "item",
      "get",
      itemId,
      "--vault",
      vaultId,
      "--format",
      "json",
      "--reveal",
    ]);
    const expected = login();
    expected.fields = [
      {
        id: "password",
        purpose: "PASSWORD",
        type: "CONCEALED",
        value: "fixture replacement",
      },
      {
        id: "username",
        purpose: "USERNAME",
        type: "STRING",
        value: "fixture user",
      },
    ];
    expect(test.stored()).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("fixture replacement");
  });

  it.each(["item", "vault", "password"])(
    "rejects missing %s without invoking the provider",
    async (missing) => {
      const test = fixture();
      await expect(
        password(
          test.port,
          {
            ...options,
            item: missing === "item" ? " " : options.item,
            vault: missing === "vault" ? " " : options.vault,
          },
          missing === "password" ? " " : "replacement",
        ),
      ).rejects.toThrow("required");
      expect(test.calls).toHaveLength(0);
    },
  );

  it.each<RecordValue>([
    { category: "SECURE_NOTE" },
    { id: "invalid" },
    { fields: [] },
    {
      fields: [
        {
          id: "password",
          purpose: "PASSWORD",
          type: "CONCEALED",
          section: "custom",
        },
      ],
    },
    { passkeys: [{ id: "fixture passkey" }] },
    {
      fields: [
        { id: "password", purpose: "PASSWORD", type: "CONCEALED" },
        { id: "passkey", type: "PASSKEY" },
      ],
    },
  ])("refuses unsafe login shapes before edit", async (patch) => {
    const test = fixture({ ...login(), ...patch });
    await expect(password(test.port, options, "replacement")).rejects.toThrow();
    expect(test.calls).toHaveLength(1);
  });

  it("requires explicit imported-field repair and refuses repaired ID collisions", async () => {
    const item = login();
    item.fields = [
      {
        id: "password",
        purpose: "PASSWORD",
        type: "CONCEALED",
        value: "original",
      },
      { value: "imported fixture" },
    ];
    const denied = fixture(item);
    await expect(password(denied.port, options, "replacement")).rejects.toThrow(
      "explicit repair",
    );
    const allowed = fixture(item);
    await expect(
      password(
        allowed.port,
        { ...options, repairImportedFields: true },
        "replacement",
      ),
    ).resolves.toMatchObject({ verified: true });
    expect(allowed.stored().fields).toContainEqual({
      id: "imported_field_2",
      label: "Imported field 2",
      type: "CONCEALED",
      value: "imported fixture",
    });
    const collision = fixture({
      ...item,
      fields: [
        { id: "password", purpose: "PASSWORD", type: "CONCEALED" },
        { value: "imported" },
        { id: "imported_field_2", value: "existing" },
      ],
    });
    await expect(
      password(
        collision.port,
        { ...options, repairImportedFields: true },
        "replacement",
      ),
    ).rejects.toThrow("collide");
    expect(collision.calls).toHaveLength(1);
  });

  it.each<RecordValue>([
    { id: "c".repeat(26) },
    { title: "changed" },
    { category: "SECURE_NOTE" },
    { vault: { id: "c".repeat(26), name: "fixture vault" } },
    { vault: { id: vaultId, name: "changed" } },
    { fields: [] },
    { tags: [] },
    { notesPlain: "changed" },
  ])(
    "withholds verification when readback changes identity or template",
    async (patch) => {
      const test = fixture();
      test.readback((item) => ({ ...item, ...patch }));
      await expect(password(test.port, options, "replacement")).rejects.toThrow(
        "unverified",
      );
      expect(test.calls).toHaveLength(3);
    },
  );

  it("suppresses provider failures and does not retry uncertain writes", async () => {
    const test = fixture();
    test.failEdit();
    await expect(password(test.port, options, "replacement")).rejects.toThrow(
      "unverified",
    );
    expect(test.calls).toHaveLength(2);
    const unavailable: PasswordAgentPort = {
      async invoke() {
        throw new Error("private provider fixture");
      },
    };
    await expect(password(unavailable, options, "replacement")).rejects.toThrow(
      "nothing was changed (details suppressed)",
    );
  });
});
