/** A failed old write cannot restore its body into a successor admission. */
import type { VaultBody } from "@opensesame/vault-core";
import { assertDecoyBodyBudget } from "../decoy-budget.js";
import { isDecoySession } from "../decoy-session.js";
import { observeDecoyInteraction } from "../decoy-session.js";
import { bodyBeforeWrite } from "./body-edits.js";
export async function applyGuardedBodyChange(
  change: (body: VaultBody) => void,
  check: () => void,
  read: () => VaultBody,
  install: (body: VaultBody) => void,
  persist: () => Promise<void>,
  notify: (rollback: boolean) => void,
): Promise<void> {
  check();
  const previous = bodyBeforeWrite(read());
  try {
    change(read());
    if (isDecoySession()) assertDecoyBodyBudget(read());
    await persist();
    check();
    observeDecoyInteraction("vault_write");
  } catch (error) {
    check();
    install(previous);
    notify(true);
    throw error;
  }
  notify(false);
}
