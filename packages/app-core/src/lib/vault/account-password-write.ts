import type { AccountItem, PasswordMethod } from "@opensesame/vault-core";
import { assertNotDecoySession } from "../decoy-session.js";
import { assertShareReach } from "../local-share-reach.js";
import { pinTombAuthority } from "../vfs.js";
import { itemText } from "./item-departure.js";
import { matchesWrittenAccount } from "./password-workflow-account.js";
import { vaultStore } from "./store.js";

function currentAccount(tomb: string, original: AccountItem): AccountItem {
  const state = vaultStore.getSnapshot();
  if (
    state.status !== "unlocked" ||
    state.awaitingSecondStep ||
    state.tomb !== tomb
  )
    throw new Error(
      "The account is no longer available in this unlocked vault.",
    );
  const account = state.items.find(
    (item) => item.id === original.id && item.deletedAt === null,
  );
  if (account?.kind !== "account" || itemText(account) !== itemText(original))
    throw new Error(
      "The account changed or was withdrawn. Start the password action again.",
    );
  return account;
}

/** Human password actions must retain the original account across private prompts. */
export async function updateLocalAccountPasswordMethod(
  tomb: string,
  original: AccountItem,
  next: PasswordMethod,
): Promise<void> {
  const generation = assertNotDecoySession();
  currentAccount(tomb, original);
  const check = pinTombAuthority(tomb);
  await assertShareReach(tomb, { kind: "item", id: original.id }, "write");
  check();
  assertNotDecoySession(generation);
  const account = currentAccount(tomb, original);
  const matches = account.methods.filter((method) => method.id === next.id);
  if (
    next.type !== "password" ||
    matches.length !== 1 ||
    matches[0]?.type !== "password"
  )
    throw new Error("Choose exactly one existing account password method.");
  const expected: AccountItem = {
    ...account,
    updatedAt: new Date().toISOString(),
    methods: account.methods.map((method) =>
      method.id === next.id ? next : method,
    ),
  };
  try {
    await vaultStore.saveItem(expected);
    check();
    assertNotDecoySession(generation);
    const state = vaultStore.getSnapshot();
    const saved = state.items.find((item) => item.id === expected.id);
    if (
      state.status !== "unlocked" ||
      state.awaitingSecondStep ||
      state.tomb !== tomb ||
      saved?.kind !== "account" ||
      !matchesWrittenAccount(saved, expected, original)
    )
      throw new Error("The saved account did not match the password update.");
  } catch {
    throw new Error(
      "The password write is unverified. Do not retry automatically (details suppressed).",
    );
  }
}
