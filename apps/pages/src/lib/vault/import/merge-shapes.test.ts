import { describe, expect, it } from "vitest";
import { defaultMergeOptions, planMerge } from "./merge.js";
import { draftLogin, draftNote, draftSecret } from "./types.js";

describe("planMerge item shapes", () => {
  it("carries a login's fields and uris into the vault item", () => {
    const login = draftLogin("Mail");
    login.username = "ada";
    login.password = "hunter2";
    login.totp = "JBSWY3DPEHPK3PXP";
    login.fields = [
      { name: "Account number", value: "1234", hidden: false },
      { name: "PIN", value: "9876", hidden: true },
    ];
    login.uris = [
      { uri: "https://mail.example.com", match: "host" },
      { uri: "https://backup.example.com", match: "exact" },
    ];

    const plan = planMerge([login], [], [], defaultMergeOptions);
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0];
    if (item?.kind !== "login") throw new Error("expected login");
    expect(item.fields).toEqual([
      expect.objectContaining({
        name: "Account number",
        value: "1234",
        hidden: false,
      }),
      expect.objectContaining({ name: "PIN", value: "9876", hidden: true }),
    ]);
    // Field and URI ids are minted fresh at merge time, not reused.
    expect(item.fields[0]?.id).toBeTruthy();
    expect(item.uris.map((u) => u.match)).toEqual(["host", "exact"]);
    expect(item.totp).toBe("JBSWY3DPEHPK3PXP");
  });

  it("lands a secret with an empty ceiling for the operator to fill", () => {
    const secret = draftSecret("Deploy webhook");
    secret.value = "whsec_123";
    const note = draftNote("Recovery");

    const plan = planMerge([secret, note], [], [], defaultMergeOptions);
    const landed = plan.items[0];
    if (landed?.kind !== "secret") throw new Error("expected secret");
    expect(landed.value).toBe("whsec_123");
    // An import never grants capability on its own.
    expect(landed.ceiling).toEqual([]);
    expect(landed.grantees).toEqual([]);
    expect(landed.connectionRef).toBe("");
    expect(plan.items[1]?.kind).toBe("note");
  });
});
