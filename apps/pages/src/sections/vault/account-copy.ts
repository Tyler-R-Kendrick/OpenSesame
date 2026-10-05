import { readAccountPassword } from "@opensesame/app-core/lib/account-password.js";
import { concealedValue } from "@opensesame/app-core/sections/vault-section-model.js";
import {
  type AccountItem,
  type VaultItem,
  needsPepper,
  passwordMethod,
} from "@opensesame/vault-core";
import {
  type PepperAskFn,
  isPepperCancelled,
} from "../../components/PepperPrompt.js";

/**
 * Whether the list's "copy secret" has something to give: an account's
 * password counts when it is stored or when the person can be asked for it.
 */
export function canCopySecret(item: VaultItem): boolean {
  if (item.kind !== "account") return Boolean(concealedValue(item));
  const method = passwordMethod(item);
  return method !== undefined && (needsPepper(method) || method.secret !== "");
}

/**
 * The password of an account for one copy, asking for its pepper first when it
 * needs one. `null` is nothing to copy: cancelled, wrong, or none.
 */
export async function accountSecretToCopy(
  item: AccountItem,
  ask: PepperAskFn,
): Promise<string | null> {
  const reading = await readAccountPassword(item, async () => {
    try {
      return await ask("enter", "Use pepper");
    } catch (caught) {
      if (isPepperCancelled(caught)) return null;
      throw caught;
    }
  });
  return reading.status === "ok" ? reading.password : null;
}
