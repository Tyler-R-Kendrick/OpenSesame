/** Selected item writes retain their originating operation ceiling. */
import {
  type VaultBody,
  type VaultItem,
  resolveAccounts,
} from "@opensesame/vault-core";
import type { WriteOperation } from "../vfs-write-contract.js";
import type { ItemWriteHost } from "./item-writes.js";
export type Check = () => void;
export type BodyEdit = (body: VaultBody) => void;
export type Items = readonly VaultItem[];
export function itemWriteHost(
  tomb: string,
  items: Items,
  checkStore: Check,
  ceiling: Check | undefined,
  mutate: (change: BodyEdit, operation: WriteOperation) => Promise<void>,
): ItemWriteHost {
  let accepted = false;
  const check = () => {
    checkStore();
    if (!accepted) ceiling?.();
  };
  const operation: WriteOperation = {
    check,
    accept: () => {
      check();
      accepted = true;
    },
  };
  return {
    tomb,
    items: resolveAccounts(items),
    check,
    mutate: (change) =>
      mutate((body) => {
        check();
        change(body);
      }, operation),
  };
}
