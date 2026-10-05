import type {
  BoundaryValue,
  JsonObject,
  JsonValue,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";

import { CXF_EXTENSION } from "../../export/cxf.js";
import { defaultMergeOptions, planMerge } from "../merge.js";
import type { DraftAccount, DraftItem } from "../types.js";
import { fidoCxf } from "./cxf.js";

/**
 * An account holds several login methods (ADR 0171), and CXF expresses them as
 * several credentials under one item. These read documents written elsewhere
 * where every credential is present, absent or repeated.
 */

function parse(items: JsonValue[]): DraftItem[] {
  const json: JsonObject = {
    version: 1,
    exporter: "SomeOtherManager",
    timestamp: 1_772_600_767,
    accounts: [{ id: "acct", username: "", email: "", collections: [], items }],
  };
  const value: BoundaryValue = json;
  return fidoCxf.parse({
    fileName: "export.json",
    text: JSON.stringify(json),
    headers: null,
    json: value,
    bytes: null,
  }).items;
}

function only(items: DraftItem[]): DraftAccount {
  const [item] = items;
  if (item?.kind !== "account") throw new Error("expected an account");
  return item;
}

function row(title: string, credentials: JsonValue[]): JsonValue {
  return {
    id: title,
    creationAt: 1_767_324_245,
    modifiedAt: 1_770_090_306,
    title,
    credentials,
  };
}

const basic = (password: string) => ({
  type: "basic-auth",
  username: { fieldType: "string", value: "ada" },
  password: { fieldType: "concealed-string", value: password },
});
const totp = (secret: string) => ({
  type: "totp",
  secret,
  period: 30,
  digits: 6,
  algorithm: "sha1",
  username: "ada",
});

describe("CXF credentials become login methods", () => {
  it("reads a basic-auth as the password and a totp as the authenticator", () => {
    const account = only(
      parse([row("Both", [basic("pw"), totp("JBSWY3DPEHPK3PXP")])]),
    );
    expect(account.password).toBe("pw");
    expect(account.totp).toBe("JBSWY3DPEHPK3PXP");
    expect(account.methods).toEqual([]);
  });

  it("reads an item with only a totp as an account with no password", () => {
    const account = only(parse([row("Seed", [totp("JBSWY3DPEHPK3PXP")])]));
    expect(account.password).toBe("");
    expect(account.totp).toBe("JBSWY3DPEHPK3PXP");
    const landed = planMerge([account], [], [], defaultMergeOptions).items[0];
    if (landed?.kind !== "account") throw new Error("expected an account");
    expect(landed.methods.map((method) => method.type)).toEqual([
      "authenticator",
    ]);
  });

  it("keeps every credential when an item carries several of a type", () => {
    const account = only(
      parse([
        row("Many", [
          basic("pw-one"),
          basic("pw-two"),
          totp("JBSWY3DPEHPK3PXP"),
          totp("KRSXG5CTMVRXEZLU"),
        ]),
      ]),
    );
    expect(account.password).toBe("pw-one");
    expect(account.totp).toBe("JBSWY3DPEHPK3PXP");
    expect(account.methods).toEqual([
      { type: "password", secret: "pw-two" },
      { type: "authenticator", secret: "KRSXG5CTMVRXEZLU" },
    ]);
  });

  it("reads an api-key beside a password as a method of the account", () => {
    const account = only(
      parse([
        row("Service", [
          basic("pw"),
          {
            type: "api-key",
            key: { fieldType: "concealed-string", value: "key-123" },
            extensions: [{ name: CXF_EXTENSION, header: "X-Api-Key" }],
          },
        ]),
      ]),
    );
    expect(account.methods).toEqual([
      { type: "api-key", key: "key-123", header: "X-Api-Key" },
    ]);
  });

  it("still reads an api-key on its own as a secret, as it always has", () => {
    const [item] = parse([
      row("Weather", [
        {
          type: "api-key",
          key: { fieldType: "concealed-string", value: "key-123" },
        },
      ]),
    ]);
    expect(item).toMatchObject({ kind: "secret", value: "key-123" });
  });

  it("takes the username from a basic-auth that names no password", () => {
    const account = only(
      parse([
        row("Withheld", [
          {
            type: "basic-auth",
            username: { fieldType: "string", value: "ada" },
          },
          totp("JBSWY3DPEHPK3PXP"),
        ]),
      ]),
    );
    expect(account.username).toBe("ada");
    expect(account.password).toBe("");
    expect(account.methods).toEqual([]);
  });
});
