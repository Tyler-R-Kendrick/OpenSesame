import { describe, expect, it } from "vitest";

import { accountPlainPassword, accountTotp } from "@opensesame/vault-core";
import { parseImport } from "./index.js";
import { defaultMergeOptions, planMerge } from "./merge.js";

/**
 * Every importer lands an account (ADR 0166): the password in a manual,
 * unpeppered method and a seed in an authenticator method.
 */

function landed(text: string, fileName: string) {
  const result = parseImport({
    fileName,
    text,
    headers: text.split("\n")[0]?.split(",") ?? null,
    json: null,
    bytes: null,
  });
  const [item] = planMerge(result.items, [], [], defaultMergeOptions).items;
  if (item?.kind !== "account") throw new Error("expected an account");
  return item;
}

describe("a CSV login lands as an account", () => {
  const header =
    "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp";

  it("puts the password in a manual method and the seed in an authenticator", () => {
    const item = landed(
      `${header}\n,0,login,Mail,,,0,https://mail.example,ada,hunter2,JBSWY3DPEHPK3PXP`,
      "bw.csv",
    );
    expect(item.username).toBe("ada");
    expect(accountPlainPassword(item)).toBe("hunter2");
    expect(accountTotp(item)).toBe("JBSWY3DPEHPK3PXP");
    expect(item.methods).toHaveLength(2);
    expect(item.methods[0]).toMatchObject({
      type: "password",
      generator: { id: "manual" },
      pepper: false,
    });
  });

  it("keeps a seed with no password as an authenticator alone", () => {
    const item = landed(
      `${header}\n,0,login,Mail,,,0,https://mail.example,ada,,JBSWY3DPEHPK3PXP`,
      "bw.csv",
    );
    expect(item.methods.map((method) => method.type)).toEqual([
      "authenticator",
    ]);
    expect(accountPlainPassword(item)).toBe("");
    expect(accountTotp(item)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("gives a login with neither one empty password method", () => {
    const item = landed(
      `${header}\n,0,login,Mail,,,0,https://mail.example,ada,,`,
      "bw.csv",
    );
    expect(item.methods).toHaveLength(1);
    expect(item.methods[0]).toMatchObject({ type: "password", secret: "" });
  });
});
