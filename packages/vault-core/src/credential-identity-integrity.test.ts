import { expect, it } from "vitest";
import { manualPassword } from "./account.js";
import {
  bindCredential,
  saveCredential,
  unbindCredential,
} from "./credential-bind.js";
import { createCredential } from "./credential.js";
import { createItem } from "./model.js";
const at = "2026-10-06T00:00:00.000Z";
it("refuses wrong-kind and duplicate credential identities without changing input", () => {
  const note = createItem("note", "Preserved note");
  const credential = createCredential(
    manualPassword(note.id, "sentinel", at),
    "Credential",
  );
  const account = createItem("account", "Account");
  const rows = [note, credential, account];
  expect(saveCredential([note], credential, at)).toEqual({
    ok: false,
    refusal: "invalid-identity",
  });
  expect(saveCredential(rows, credential, at)).toEqual({
    ok: false,
    refusal: "invalid-identity",
  });
  expect(bindCredential(rows, credential.id, account.id, at)).toEqual({
    ok: false,
    refusal: "invalid-identity",
  });
  expect(() => unbindCredential(rows, credential.id, at)).toThrow("identity");
  expect(rows[0]).toBe(note);
  expect(rows[1]).toBe(credential);
});
it("refuses mismatched method identity and ambiguous account targets; valid edits remain accepted", () => {
  const credential = createCredential(
    manualPassword("credential", "sentinel", at),
    "Credential",
  );
  const account = createItem("account", "Account");
  expect(
    saveCredential(
      [credential],
      { ...credential, method: { ...credential.method, id: "foreign" } },
      at,
    ),
  ).toEqual({ ok: false, refusal: "invalid-identity" });
  expect(
    bindCredential(
      [credential, account, { ...account }],
      credential.id,
      account.id,
      at,
    ),
  ).toEqual({ ok: false, refusal: "invalid-identity" });
  expect(
    saveCredential([credential], { ...credential, notes: "valid edit" }, at).ok,
  ).toBe(true);
});
