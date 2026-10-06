import {
  type AccountItem,
  passwordMethod,
  pepperBinding,
  sealWithPepper,
} from "@opensesame/vault-core";
import { makeAccount } from "./account.test-support.js";

export const PLAIN = "correct-horse-battery";

async function sealPassword() {
  const base = makeAccount({ id: "itm_pep", password: PLAIN });
  const method = passwordMethod(base);
  if (!method) throw new Error("fixture");
  const sealed: typeof method = {
    ...method,
    pepper: true,
    secret: "",
    sealed: await sealWithPepper(
      PLAIN,
      "right",
      pepperBinding(base.id, method.id),
    ),
  };
  return { account: { ...base, methods: [sealed] }, method: sealed };
}

let sealed: ReturnType<typeof sealPassword> | undefined;

/**
 * An account an older version made: its password sealed under the pepper
 * `right`. Sealing is one real PBKDF2 at its production strength, and the
 * sealed record is never changed by a test, so it is derived once for the file
 * rather than once per test.
 */
export function sealedAccount() {
  sealed ??= sealPassword();
  return sealed;
}

/** A stored password with a slot for the person's own pepper at `at`. */
export function slottedAccount(password: string, at?: string): AccountItem {
  const base = makeAccount({ id: "itm_slot", password });
  const method = passwordMethod(base);
  if (!method) throw new Error("fixture");
  return {
    ...base,
    methods: [
      {
        ...method,
        pepper: true,
        ...(at === undefined ? undefined : { pepperAt: at }),
      },
    ],
  };
}
